"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { POSE_NAMES, validWebp } = require("./avatar-package");

const REPO = "Aspksa/Amayurena";
const API = "https://api.github.com/repos/" + REPO;
const SHA_PATTERN = /^[a-f0-9]{40}$/i;

function makeError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function collectAvatars(rootDir) {
  const root = fs.realpathSync(rootDir);
  const location = path.join(root, "assets", "avatars");
  if (!fs.existsSync(location)) throw makeError("Позы не установлены. Сначала установите ZIP-архив.");
  const resolved = fs.realpathSync(location);
  if (resolved !== location && !resolved.startsWith(root + path.sep)) {
    throw makeError("Каталог аватаров находится за пределами проекта.");
  }
  let total = 0;
  const images = [];
  const hashes = new Map();
  for (const name of POSE_NAMES) {
    const filename = path.join(resolved, name);
    let stats;
    try { stats = fs.lstatSync(filename); }
    catch (_) { throw makeError("Не найдено изображение " + name); }
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size < 16 || stats.size > 5 * 1024 * 1024) {
      throw makeError("Недопустимый файл " + name);
    }
    total += stats.size;
    if (total > 30 * 1024 * 1024) throw makeError("Общий размер аватаров превышает 30 МБ.");
    const data = fs.readFileSync(filename);
    if (!validWebp(data)) throw makeError("Файл " + name + " не является корректным WebP.");
    const hash = crypto.createHash("sha256").update(data).digest("hex");
    const duplicate = hashes.get(hash) || null;
    if (!duplicate) hashes.set(hash, name);
    images.push({ name, size: data.length, sha256: hash, duplicate, data });
  }
  return images;
}

function status(rootDir, env = process.env) {
  const configured = Boolean(env.AMAYURENA_GITHUB_TOKEN && env.AMAYURENA_GITHUB_TOKEN.trim());
  try {
    const images = collectAvatars(rootDir);
    return {
      installed: images.length, configured,
      totalBytes: images.reduce((sum, image) => sum + image.size, 0),
      unique: new Set(images.map(image => image.sha256)).size,
      duplicates: images.filter(image => image.duplicate).map(image => ({
        pose: image.name, identicalTo: image.duplicate
      }))
    };
  } catch (_) {
    return { installed: 0, configured, totalBytes: 0, unique: 0, duplicates: [] };
  }
}

function validSha(sha) {
  if (typeof sha !== "string" || !SHA_PATTERN.test(sha)) {
    throw makeError("GitHub вернул некорректный идентификатор коммита.", 502);
  }
  return sha;
}

async function publishAvatars(rootDir, env = process.env, fetchImpl = fetch, options = {}) {
  const token = env.AMAYURENA_GITHUB_TOKEN;
  if (typeof token !== "string" || !token.trim())
    throw makeError("Токен GitHub не настроен. Укажите AMAYURENA_GITHUB_TOKEN для своего аккаунта.", 503);
  const images = collectAvatars(rootDir);
  const randomHex = (options.randomBytes || crypto.randomBytes)(5).toString("hex");
  const branch = "avatar-images-" + (options.now || new Date()).toISOString().slice(0, 10).replace(/-/g, "") + "-" + randomHex;

  async function api(method, endpoint, body) {
    let response;
    try {
      response = await fetchImpl(API + endpoint, {
        method,
        headers: {
          "Authorization": "Bearer " + token,
          "Accept": "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "Amayurena-Avatar-Publisher"
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(45000)
      });
    } catch (_) { throw makeError("Соединение с GitHub недоступно.", 502); }
    if (!response.ok) {
      const hint = response.status === 401 ? "Проверьте GitHub-токен."
        : response.status === 403 ? "Проверьте права Contents и Pull requests для репозитория."
        : response.status === 422 ? "GitHub отклонил данные. Проверьте права и состояние репозитория."
        : "GitHub вернул HTTP " + response.status + ".";
      throw makeError(hint, response.status === 401 || response.status === 403 ? 403 : 502);
    }
    try { return await response.json(); }
    catch (_) { throw makeError("GitHub вернул некорректный ответ.", 502); }
  }

  const baseRef = await api("GET", "/git/ref/heads/main");
  const baseSha = validSha(baseRef?.object?.sha);
  const commit = await api("GET", "/git/commits/" + baseSha);
  const treeSha = validSha(commit?.tree?.sha);

  const tree = [];
  for (const image of images) {
    const blob = await api("POST", "/git/blobs", {
      content: image.data.toString("base64"), encoding: "base64"
    });
    tree.push({
      path: "assets/avatars/" + image.name,
      mode: "100644", type: "blob", sha: validSha(blob?.sha)
    });
  }

  const createdTree = await api("POST", "/git/trees", { base_tree: treeSha, tree });
  const newTreeSha = validSha(createdTree?.sha);
  const newCommit = await api("POST", "/git/commits", {
    message: "assets(avatar): install 10 official Amayurena poses",
    tree: newTreeSha, parents: [baseSha]
  });
  const newSha = validSha(newCommit?.sha);

  // Create the new branch only after every blob/tree/commit object has been prepared.
  await api("POST", "/git/refs", { ref: "refs/heads/" + branch, sha: newSha });
  const pr = await api("POST", "/pulls", {
    title: "Добавить 10 изображений аватара Амаюрэны",
    head: branch,
    base: "main",
    body: "Загружено из локального приложения Amayurena после явного подтверждения.\n\n" +
      "Все 10 WebP валидированы. Без изменений исполняемого кода.\n" +
      "Уникальных изображений: " + new Set(images.map(i => i.sha256)).size + ".\n" +
      "Просмотрите изображения и дождитесь успешных проверок перед слиянием."
  });
  const url = pr?.html_url;
  if (typeof url !== "string" || !/^https:\/\/github\.com\/Aspksa\/Amayurena\/pull\/\d+$/.test(url)) {
    throw makeError("Коммит создан, но GitHub не вернул ссылку PR. Проверьте раздел Pull requests.", 502);
  }
  return { pullRequest: url, branch, published: images.length, unique: new Set(images.map(i => i.sha256)).size };
}

module.exports = { REPO, collectAvatars, status, publishAvatars };

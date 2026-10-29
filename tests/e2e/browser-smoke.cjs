"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const {chromium}=require("playwright");
const {createServer}=require("../../server");

async function main(){
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),"amayu-browser-"));
  const server=createServer({
    env:{},
    knowledgeDirectory:path.join(temp,"notes"),
    knowledgeHistoryDirectory:path.join(temp,"history"),
    knowledgeCanvasDirectory:path.join(temp,"canvases"),
    knowledgeBasesDirectory:path.join(temp,"bases"),
    knowledgeDataDirectory:temp,
    updateFetchImpl:async()=>({ok:false,status:404})
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const origin="http://127.0.0.1:"+server.address().port;
  let browser,page;
  const errors=[];
  try{
    browser=await chromium.launch({headless:true});
    page=await browser.newPage({viewport:{width:1380,height:850}});
    page.setDefaultTimeout(16000);
    page.on("pageerror",error=>errors.push(error.stack||error.message));
    await page.goto(origin,{waitUntil:"domcontentloaded"});
    await page.locator("#home-view").waitFor({state:"visible"});

    // Create an agent without sending a paid API request.
    await page.locator('[data-page="agents"]').click();
    await page.locator("#create-agent").click();
    await page.locator("#agent-dialog").waitFor({state:"visible"});
    await page.locator("#agent-name").fill("Тестовый агент");
    await page.locator("#agent-role").fill("Диагностика UI");
    await page.locator('#agent-form button[type="submit"]').click();
    await page.locator("#agent-dialog").waitFor({state:"hidden"});
    await page.locator("#agent-grid").getByText("Тестовый агент").first().waitFor();
    const open=page.locator("#agent-grid button").filter({hasText:/Открыть/}).first();
    if(await open.count()){
      await open.click();
      await page.locator("#agent-workspace").waitFor({state:"visible"});
      await page.locator("#workspace-new-chat").click();
      assert.ok((await page.locator("#workspace-chat-select option").count())>=2,
        "Multiple conversations should be selectable.");
      await page.locator("#workspace-chat-search").fill("несуществующее");
      await page.locator("#workspace-back").click();
    }

    // Exercise actual browser note creation, saving and reload from local disk.
    await page.locator('[data-page="knowledge"]').click();
    await page.locator("#knowledge-view").waitFor({state:"visible"});
    await page.locator("#knowledge-create").click();
    await page.locator("#knowledge-create-dialog").waitFor({state:"visible"});
    await page.locator("#knowledge-create-name").fill("Проверка интерфейса");
    await page.locator("#knowledge-create-submit").click();
    await page.locator("#knowledge-create-dialog").waitFor({state:"hidden"});
    await page.locator("#knowledge-editor-panel").waitFor({state:"visible"});
    const text="# Проверка интерфейса\n\nРедактор сохраняет содержимое на диск.\n\n## Глава\n";
    await page.locator("#knowledge-editor").fill(text);
    await page.locator("#knowledge-save").click();
    const file="Проверка интерфейса.md";
    let found=false;
    for(let i=0;i<35;i++){
      const r=await fetch(origin+"/api/knowledge/note?path="+encodeURIComponent(file));
      if(r.ok && (await r.json()).content===text){found=true;break;}
      await new Promise(res=>setTimeout(res,140));
    }
    assert.ok(found,"The saved Markdown must be available from the disk-backed API.");
    await page.locator("#knowledge-editor-view-split").click();
    assert.equal(await page.locator("#knowledge-editor-layout").getAttribute("data-layout"),"split");
    assert.ok((await page.locator("#knowledge-outline-list").innerText()).includes("Глава"));

    // Canvas: create board, add a card, persist it, and check server state.
    await page.locator("#knowledge-canvas-tab").click();
    await page.locator("#knowledge-canvas-panel").waitFor({state:"visible"});
    page.once("dialog",dialog=>dialog.accept("QA доска"));
    await page.locator("#knowledge-canvas-new").click();
    await page.waitForFunction(()=>document.querySelector("#knowledge-canvas-select").value==="QA доска");
    page.once("dialog",dialog=>dialog.accept("Карточка smoke"));
    await page.locator("#knowledge-canvas-text").click();
    await page.locator("#knowledge-canvas-save").click();
    let canvasSaved=false;
    for(let i=0;i<35;i++){
      const r=await fetch(origin+"/api/knowledge/canvas?name="+encodeURIComponent("QA доска"));
      if(r.ok && (await r.json()).nodes.some(n=>n.text==="Карточка smoke")){canvasSaved=true;break;}
      await new Promise(res=>setTimeout(res,120));
    }
    assert.ok(canvasSaved,"Canvas card was not saved to disk.");

    // Bases and graph should remain responsive after editor/Canvas transitions.
    await page.locator("#knowledge-bases-tab").click();
    await page.locator("#knowledge-bases-panel").waitFor({state:"visible"});
    assert.equal(await page.locator("#knowledge-bases-filter-join").count(),1);
    await page.locator("#knowledge-insights-tab").click();
    await page.locator("#knowledge-insights-panel").waitFor({state:"visible"});
    await page.locator("#knowledge-insights-refresh").click();
    await page.waitForFunction(()=>document.querySelector("#knowledge-insights-stats").children.length>0);
    await page.setViewportSize({width:390,height:800});
    assert.ok(await page.locator("#knowledge-view").isVisible(),"Knowledge workspace must remain visible on mobile.");
    await page.locator("#knowledge-canvas-tab").click();
    assert.ok(await page.locator("#knowledge-canvas-panel").isVisible(),"Mobile Canvas should be accessible.");
    assert.deepEqual(errors,[],"Uncaught browser errors: "+errors.join(" | "));
    console.log("Browser E2E: agents/chat, saved note, Canvas, Bases, graph and mobile navigation PASS");
  }catch(e){
    if(page){
      const file=path.join(os.tmpdir(),"amayurena-smoke-"+Date.now()+".png");
      try{await page.screenshot({path:file,fullPage:true,timeout:5000});console.error("Screenshot: "+file);}catch(_){}
    }
    if(errors.length)console.error("Browser errors:",errors);
    throw e;
  }finally{
    if(browser)await browser.close();
    await new Promise(resolve=>server.close(resolve));
    fs.rmSync(temp,{recursive:true,force:true});
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});

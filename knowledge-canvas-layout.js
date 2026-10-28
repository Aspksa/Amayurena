"use strict";
(function (root, factory) {
  const output=factory();
  if (typeof module!=="undefined" && module.exports) module.exports=output;
  if (root) root.AmayurenaCanvasLayout=output;
})(typeof window!=="undefined" ? window : null,function () {
  const WIDTH=3500, HEIGHT=2600, CARD_W=220, CARD_H=124;
  const MIN_ZOOM=.35, MAX_ZOOM=2;
  const clamp=(v,min,max)=>Math.min(max,Math.max(min,v));
  function zoom(value) { return clamp(Number.isFinite(value)?value:1,MIN_ZOOM,MAX_ZOOM); }
  function arrange(board) {
    if (!board || !Array.isArray(board.nodes) || !Array.isArray(board.groups)) throw Error("Неверная доска.");
    const copy=JSON.parse(JSON.stringify(board));
    const groups=[...copy.groups].sort((a,b)=>a.id.localeCompare(b.id));
    const assigned=new Set();
    let x=35,y=35,rowHeight=0;
    for (const group of groups) {
      const members=copy.nodes.filter(n=>n.groupId===group.id).sort((a,b)=>a.id.localeCompare(b.id));
      const n=Math.max(1,members.length);
      const cols=Math.max(1,Math.min(11,Math.ceil(Math.sqrt(n*1.6))));
      const rows=Math.ceil(n/cols);
      group.width=Math.max(320,cols*245+35);
      group.height=Math.max(220,rows*166+55);
      if (x+group.width>WIDTH-35) {
        x=35;y+=rowHeight+25;rowHeight=0;
      }
      if (y+group.height>HEIGHT-35) throw Error("Для автоматической раскладки недостаточно места на доске.");
      group.x=x;group.y=y;
      x+=group.width+25;
      rowHeight=Math.max(rowHeight,group.height);
      for(let i=0;i<members.length;i++){
        const card=members[i];
        card.x=group.x+25+(i%cols)*245;
        card.y=group.y+55+Math.floor(i/cols)*166;
        assigned.add(card.id);
      }
    }
    const independent=copy.nodes.filter(n=>!assigned.has(n.id)).sort((a,b)=>a.id.localeCompare(b.id));
    if(independent.length) {
      const cols=Math.min(12,independent.length);
      const rows=Math.ceil(independent.length/cols);
      let startY=groups.length?y+rowHeight+30:40;
      if(startY+(rows-1)*165+CARD_H>HEIGHT-30) {
        // Fall back to the remaining right-hand side when groups have used the bottom.
        if(x+cols*265>WIDTH-30) throw Error("Для независимых карточек недостаточно места.");
        startY=40;
      }
      for(let i=0;i<independent.length;i++){
        independent[i].x=40+(i%cols)*265;
        independent[i].y=startY+Math.floor(i/cols)*165;
        if(independent[i].x>WIDTH-CARD_W || independent[i].y>HEIGHT-CARD_H)
          throw Error("Нельзя разместить все карточки в пределах доски.");
      }
    }
    return copy;
  }
  function viewAt(oldZoom,newZoom,scrollLeft,scrollTop,viewWidth,viewHeight) {
    const old=zoom(oldZoom), next=zoom(newZoom);
    const centerX=(scrollLeft+viewWidth/2)/old;
    const centerY=(scrollTop+viewHeight/2)/old;
    return {zoom:next,left:clamp(centerX*next-viewWidth/2,0,Math.max(0,WIDTH*next-viewWidth)),
      top:clamp(centerY*next-viewHeight/2,0,Math.max(0,HEIGHT*next-viewHeight))};
  }
  function minimapRect(scrollLeft,scrollTop,viewWidth,viewHeight,currentZoom,mapWidth=200,mapHeight=150) {
    const z=zoom(currentZoom);
    return {x:clamp(scrollLeft/z/WIDTH*mapWidth,0,mapWidth),
      y:clamp(scrollTop/z/HEIGHT*mapHeight,0,mapHeight),
      width:clamp(viewWidth/z/WIDTH*mapWidth,0,mapWidth),
      height:clamp(viewHeight/z/HEIGHT*mapHeight,0,mapHeight)};
  }
  return {WIDTH,HEIGHT,CARD_W,CARD_H,MIN_ZOOM,MAX_ZOOM,clamp,zoom,arrange,viewAt,minimapRect};
});
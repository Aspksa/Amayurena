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
    const members=new Set();
    let col=0,row=0;
    for (const g of groups) {
      const nodes=copy.nodes.filter(n=>n.groupId===g.id).sort((a,b)=>a.id.localeCompare(b.id));
      const grid=Math.max(1,Math.min(3,Math.ceil(Math.sqrt(Math.max(1,nodes.length)))));
      const countRows=Math.ceil(Math.max(1,nodes.length)/grid);
      g.width=clamp(Math.max(320,grid*250+32),320,950);
      g.height=clamp(Math.max(220,countRows*166+54),220,780);
      if(col+g.width>WIDTH-40) { col=0;row+=850; }
      g.x=clamp(40+col,0,WIDTH-g.width);
      g.y=clamp(40+row,0,HEIGHT-g.height);
      col+=g.width+30;
      for (let i=0;i<nodes.length;i++) {
        const n=nodes[i];
        n.x=clamp(g.x+26+(i%grid)*250,0,WIDTH-CARD_W);
        n.y=clamp(g.y+58+Math.floor(i/grid)*166,0,HEIGHT-CARD_H);
        members.add(n.id);
      }
    }
    const other=copy.nodes.filter(n=>!members.has(n.id)).sort((a,b)=>a.id.localeCompare(b.id));
    const startY=groups.length?Math.min(HEIGHT-180,row+850):40;
    for(let i=0;i<other.length;i++){
      other[i].x=clamp(40+(i%8)*265,0,WIDTH-CARD_W);
      other[i].y=clamp(startY+Math.floor(i/8)*175,0,HEIGHT-CARD_H);
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
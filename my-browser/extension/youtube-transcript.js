'use strict';
(function(root) {
  // Runs in the verified video document. Use YouTube's own transcript UI when
  // timedtext returns an empty response; no tokens, cookies or private APIs.
  async function read(expectedURL) {
    const panelSelector='ytd-engagement-panel-section-list-renderer[target-id*="transcript"]';
    const expanded=p=>p?.getAttribute('visibility')==='ENGAGEMENT_PANEL_VISIBILITY_EXPANDED';
    const existing=[...document.querySelectorAll(panelSelector)].find(expanded);
    let opened=false,interacted=false;
    const interaction=e=>{if(e.isTrusted)interacted=true;};
    const current=()=>{
      if(location.href!==expectedURL)throw Error('PAGE_CHANGED');
      const id=new URL(expectedURL).searchParams.get('v');
      const playing=document.querySelector('ytd-watch-flexy')?.getAttribute('video-id');
      if(id&&playing&&id!==playing)throw Error('PAGE_CHANGED');
    };
    document.addEventListener('pointerdown',interaction,true);
    document.addEventListener('keydown',interaction,true);
    try {
      current();
      if(!existing){
        const button=document.querySelector('ytd-video-description-transcript-section-renderer button');
        if(!button)return {ok:true,cues:[]};
        button.click();opened=true;
      }
      const deadline=Date.now()+12000;let signature='',stable=0;
      while(Date.now()<deadline){
        current();
        const panel=[...document.querySelectorAll(panelSelector)].find(p=>expanded(p)&&p.querySelector('ytd-transcript-segment-renderer'));
        const nodes=[...(panel?.querySelectorAll('ytd-transcript-segment-renderer')||[])];
        if(nodes.length>10000)throw Error('SUBTITLE_TOO_LARGE');
        const next=nodes.length+':'+nodes.at(-1)?.textContent;
        if(nodes.length&&next===signature)stable++;else stable=0;
        signature=next;
        if(stable>=2){
          let bytes=0;
          const rows=nodes.map(n=>{
            const data=n.data?.transcriptSegmentRenderer||n.data;
            const exact=Number(data?.startMs)/1000,end=Number(data?.endMs)/1000;
            const stamp=n.querySelector('.segment-timestamp')?.textContent.trim();
            const start=Number.isFinite(exact)?exact:/^\d+(?::\d{2}){1,2}$/.test(stamp||'')?stamp.split(':').reduce((sum,x)=>sum*60+Number(x),0):NaN;
            const text=n.querySelector('.segment-text')?.textContent.trim()||'';
            bytes+=text.length*2;
            if(text.length>4000||bytes>2000000)throw Error('SUBTITLE_TOO_LARGE');
            return {start,end,text};
          });
          // Never silently return a partial transcript when YouTube changes markup.
          if(rows.some(r=>!Number.isFinite(r.start)||r.start<0||!r.text))throw Error('SUBTITLE_RESPONSE_INVALID');
          const cues=[];const duration=document.querySelector('video')?.duration;
          for(let i=0;i<rows.length;){
            let j=i+1;while(j<rows.length&&rows[j].start===rows[i].start)j++;
            const row=rows[i],end=Number.isFinite(row.end)&&row.end>row.start?row.end:rows[j]?.start??duration;
            if(!Number.isFinite(end)||end<=row.start)throw Error('SUBTITLE_RESPONSE_INVALID');
            const text=rows.slice(i,j).map(r=>r.text).join(' ');
            if(text.length>4000)throw Error('SUBTITLE_TOO_LARGE');
            cues.push({start:row.start,end,text});i=j;
          }
          current();
          return {ok:true,cues};
        }
        await new Promise(resolve=>setTimeout(resolve,150));
      }
      throw Error('SUBTITLE_UNAVAILABLE');
    }catch(e){return {ok:false,error:['PAGE_CHANGED','SUBTITLE_TOO_LARGE','SUBTITLE_RESPONSE_INVALID'].includes(e.message)?e.message:'SUBTITLE_UNAVAILABLE'};}
    finally{
      document.removeEventListener('pointerdown',interaction,true);
      document.removeEventListener('keydown',interaction,true);
      // Close only the panel we opened, and only if the user has not taken over.
      if(opened&&!interacted&&location.href===expectedURL)
        [...document.querySelectorAll(panelSelector)].find(expanded)?.querySelector('#visibility-button button')?.click();
    }
  }
  const api={read};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  else root.CindyYoutubeTranscript=api;
})(globalThis);

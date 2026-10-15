import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import path from 'node:path';
const require=createRequire(import.meta.url);
const source=path.resolve(import.meta.dirname,'../my-browser/extension/youtube-transcript.js');
test('native transcript fallback reads full timed text, restores UI and rejects navigation',{
 skip:!process.env.PLAYWRIGHT_CORE,timeout:30000,
},async t=>{
 const {chromium}=require(process.env.PLAYWRIGHT_CORE);
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH});t.after(()=>browser.close());
 const page=await browser.newPage();const url='https://www.youtube.com/watch?v=fixture';
 await page.route('https://www.youtube.com/**',route=>route.fulfill({contentType:'text/html',body:`
 <ytd-watch-flexy video-id="fixture"></ytd-watch-flexy><video></video>
 <ytd-video-description-transcript-section-renderer><button>Show transcript</button></ytd-video-description-transcript-section-renderer>
 <ytd-engagement-panel-section-list-renderer target-id="engagement-panel-searchable-transcript" visibility="ENGAGEMENT_PANEL_VISIBILITY_HIDDEN"><div id="visibility-button"><button>Close</button></div><div id="rows"></div></ytd-engagement-panel-section-list-renderer>
 <script>
 const panel=document.querySelector('ytd-engagement-panel-section-list-renderer');window.opens=0;window.closes=0;
 Object.defineProperty(document.querySelector('video'),'duration',{value:20});
 document.querySelector('ytd-video-description-transcript-section-renderer button').onclick=()=>{opens++;panel.setAttribute('visibility','ENGAGEMENT_PANEL_VISIBILITY_EXPANDED');setTimeout(()=>{document.querySelector('#rows').innerHTML=[['0:00','First sentence.'],['0:02','Second sentence.'],['0:02','Continued.'],['0:15','Last sentence.']].map(([time,text])=>'<ytd-transcript-segment-renderer><div class="segment-timestamp">'+time+'</div><div class="segment-text">'+text+'</div></ytd-transcript-segment-renderer>').join('');},40);};
 document.querySelector('#visibility-button button').onclick=()=>{closes++;panel.setAttribute('visibility','ENGAGEMENT_PANEL_VISIBILITY_HIDDEN');};
 </script>`}));
 await page.goto(url);await page.addScriptTag({path:source});
 const read=()=>page.evaluate(url=>CindyYoutubeTranscript.read(url),url);
 const result=await read();assert.equal(result.ok,true);assert.equal(result.cues.length,3);
 assert.deepEqual(result.cues.map(c=>c.text),['First sentence.','Second sentence. Continued.','Last sentence.']);
 assert.deepEqual(result.cues.map(c=>[c.start,c.end]),[[0,2],[2,15],[15,20]]);
 assert.deepEqual(await page.evaluate(()=>[opens,closes]),[1,1]);
 // Precise timestamps supplied by the actual main-world renderer take priority.
 await page.evaluate(()=>{document.querySelector('ytd-video-description-transcript-section-renderer button').click();});
 await page.waitForTimeout(80);
 await page.evaluate(()=>{document.querySelector('ytd-transcript-segment-renderer').data={startMs:'120',endMs:'1750'};});
 const precise=await read();assert.equal(precise.cues[0].start,.12);assert.equal(precise.cues[0].end,1.75);
 assert.deepEqual(await page.evaluate(()=>[opens,closes]),[2,1],'existing transcript is left open');
 await page.evaluate(()=>{document.querySelector('ytd-transcript-segment-renderer .segment-timestamp').textContent='broken';delete document.querySelector('ytd-transcript-segment-renderer').data;});
 assert.equal((await read()).error,'SUBTITLE_RESPONSE_INVALID','never claim success with lost segments');
 await page.evaluate(()=>history.replaceState({},'', '/watch?v=changed'));
 assert.equal((await read()).error,'PAGE_CHANGED');
});

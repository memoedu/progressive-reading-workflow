import {JSDOM} from 'jsdom';

// Inline theme CSS must not consume the entire evidence budget and hide the
// actual list. Preserve DOM attributes used to prove article selectors.
export function htmlEvidence(html,limit=30000){
 const dom=new JSDOM(html);
 try{for(const node of dom.window.document.querySelectorAll('style,script,svg'))node.remove();return dom.window.document.body.outerHTML.slice(0,limit);}
 finally{dom.window.close();}
}

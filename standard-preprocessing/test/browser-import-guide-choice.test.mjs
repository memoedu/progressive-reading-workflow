import test from 'node:test';
import assert from 'node:assert/strict';
import {browserCaptureProcessingOptions} from '../integrations/browser-capture.mjs';
test('browser reimport retains an explicit no-guide choice while default imports keep guides',()=>{
 assert.equal(browserCaptureProcessingOptions('import').include_reading_guide,true);
 assert.equal(browserCaptureProcessingOptions('import',{include_reading_guide:false}).include_reading_guide,false);
 assert.equal(browserCaptureProcessingOptions('save',{translate:true}).translate,false);
});

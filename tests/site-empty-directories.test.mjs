import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pruneEmptySiteDirectories} from '../site-import/empty-directories.mjs';

test('empty category descendants are pruned while articles, hidden files and the site root survive',async()=>{
 const root=await fs.mkdtemp('D:/Artifacts/ProgressiveReading/empty-site-folders-');
 for(const folder of ['分类/old/nested','分类/kept','分类/hidden','标签/unused'])await fs.mkdir(path.join(root,folder),{recursive:true});
 await fs.writeFile(path.join(root,'分类/kept/article.md'),'Original article');
 await fs.writeFile(path.join(root,'分类/hidden/.state'),'Reader state');
 const removed=await pruneEmptySiteDirectories(root);
 assert.equal(removed.length,4);assert.equal(await fs.readFile(path.join(root,'分类/kept/article.md'),'utf8'),'Original article');
 assert.equal(await fs.readFile(path.join(root,'分类/hidden/.state'),'utf8'),'Reader state');
 assert.deepEqual(await pruneEmptySiteDirectories(root),[]);assert.equal((await fs.stat(root)).isDirectory(),true);
});

test('empty-folder pruning never traverses a junction outside its verified root',async()=>{
 const root=await fs.mkdtemp('D:/Artifacts/ProgressiveReading/empty-site-boundary-'),outside=await fs.mkdtemp('D:/Artifacts/ProgressiveReading/empty-site-outside-');
 await fs.mkdir(path.join(outside,'must-survive'));await fs.symlink(outside,path.join(root,'linked'),process.platform==='win32'?'junction':'dir');
 assert.deepEqual(await pruneEmptySiteDirectories(root),[]);
 assert.equal((await fs.stat(path.join(outside,'must-survive'))).isDirectory(),true);assert.equal((await fs.lstat(path.join(root,'linked'))).isSymbolicLink(),true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const server=readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
const ui=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const admin=ui.slice(ui.indexOf("if(page==='admin')"),ui.indexOf("if(page==='screen')"));

test('contest-photo replacement is removed from every moderator entry point',()=>{
 assert.doesNotMatch(server,/app\.post\('\/api\/admin\/photos\/:id\/replace'/);
 assert.doesNotMatch(server,/contestReplacementUpload\.single\('photo'\)/);
 assert.doesNotMatch(admin,/contestReplaceFile|data-replace-photo|\/replace/);
 assert.match(server,/photo\.photo_area!=='general'/);
});

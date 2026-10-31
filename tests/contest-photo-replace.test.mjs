import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const server=readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
const ui=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');

test('contest Photoshop photo replacement remains local to PHOTO WALL and does not alter BALI votes',()=>{
 assert.match(server,/app.post\('\/api\/admin\/photos\/:id\/replace'/);
 assert.match(server,/contestReplacementUpload\.single\('photo'\)/);
 assert.match(server,/contestPhotoMutationLocked\(photo\)/);
 assert.match(server,/contestPhotoMutationLocked\(latest\)/);
 assert.match(server,/UPDATE photos SET filename=\?,width=\?,height=\? WHERE id=\?/);
 assert.match(server,/INSERT INTO contest_photo_replacements/);
 assert.match(server,/await Promise\.all\(\[fsp\.unlink\(path\.join\(PHOTOS,photo\.filename\)\)/);
 assert.doesNotMatch(server,/\/api\/admin\/photos\/:id\/replace[\s\S]{0,3500}BALI_OPERATIONS_DB/);
});
test('moderator can open a file picker for an existing contestant without a second admin',()=>{
 assert.match(ui,/data-replace-photo/);
 assert.match(ui,/id="contestReplaceFile"/);
 assert.match(ui,/api\('\/api\/admin\/photos\/'.+?\+'\/replace'/s);
 assert.match(ui,/headers:\{'X-BALI-Action':'1'\}/);
});

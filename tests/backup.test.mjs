import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp,mkdir,readdir,writeFile,readFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import Database from 'better-sqlite3';

test('local backup copies valid SQLite snapshot and photos, rejects missing originals', {timeout:25000},async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'bali-local-backup-'));
  const name='123e4567-e89b-42d3-a456-426614174000.webp';
  try{
    await mkdir(path.join(dir,'photos'));
    await mkdir(path.join(dir,'thumbnails'));
    const db=new Database(path.join(dir,'bali-photo-wall.sqlite'));
    db.exec('CREATE TABLE photos(id INTEGER PRIMARY KEY,filename TEXT NOT NULL)');
    db.prepare('INSERT INTO photos(filename) VALUES(?)').run(name);
    db.close();
    await writeFile(path.join(dir,'photos',name),Buffer.from('photo content'));
    await writeFile(path.join(dir,'thumbnails',name),Buffer.from('thumbnail'));
    const exec=()=>spawnSync(process.execPath,['scripts/backup.mjs'],{
      cwd:process.cwd(),env:{...process.env,DATA_DIR:dir},encoding:'utf8',timeout:12000
    });
    let run=exec();
    assert.equal(run.status,0,run.stderr||run.stdout);
    const folders=(await readdir(path.join(dir,'backups'))).filter(x=>!x.endsWith('.partial'));
    assert.equal(folders.length,1);
    const dest=path.join(dir,'backups',folders[0]);
    const backup=new Database(path.join(dest,'bali-photo-wall.sqlite'),{readonly:true});
    assert.equal(backup.prepare('SELECT COUNT(*) AS total FROM photos').get().total,1);
    backup.close();
    assert.deepEqual(await readFile(path.join(dest,'photos',name)),Buffer.from('photo content'));
    assert.deepEqual(await readFile(path.join(dest,'thumbnails',name)),Buffer.from('thumbnail'));
    assert.equal(JSON.parse(await readFile(path.join(dest,'manifest.json'),'utf8')).photos,1);
    await rm(path.join(dir,'photos',name));
    run=exec();
    assert.notEqual(run.status,0,'A missing photo must fail the backup');
    const remaining=await readdir(path.join(dir,'backups'));
    assert.equal(remaining.length,1,'Partial/incomplete backup must not persist');
  }finally{await rm(dir,{recursive:true,force:true});}
});

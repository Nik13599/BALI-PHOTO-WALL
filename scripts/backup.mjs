// Consistent SQLite snapshot + referenced photo files, no network or paid storage.
import Database from 'better-sqlite3';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const DATA=path.resolve(process.env.DATA_DIR || path.join(ROOT,'data'));
const BACKUPS=path.resolve(process.env.BACKUP_DIR || path.join(DATA,'backups'));
const photosDir=path.join(DATA,'photos');
const thumbnailsDir=path.join(DATA,'thumbnails');
const stamp=new Date().toISOString().replace(/[:.]/g,'-');
const name='bali-backup-'+stamp+'-'+crypto.randomBytes(3).toString('hex');
const pending=path.join(BACKUPS,name+'.partial');
const completed=path.join(BACKUPS,name);
let database;
async function backup(){
  await fs.mkdir(BACKUPS,{recursive:true});
  await fs.mkdir(pending,{recursive:false});
  try {
    const source=path.join(DATA,'bali-photo-wall.sqlite');
    database=new Database(source,{readonly:true,fileMustExist:true});
    await database.backup(path.join(pending,'bali-photo-wall.sqlite'));
    await fs.mkdir(path.join(pending,'photos'));
    await fs.mkdir(path.join(pending,'thumbnails'));
    const snapshot=new Database(path.join(pending,'bali-photo-wall.sqlite'),{readonly:true});
    let fileRows;
    try {fileRows=snapshot.prepare('SELECT filename FROM photos').all();}
    finally {snapshot.close();}
    const validName=/^[a-f0-9-]{36}\.webp$/;
    let count=0;
    for (const row of fileRows) {
      if(!validName.test(row.filename))throw Error('Unsafe or unexpected file name in database snapshot');
      // Copy from live storage. Missing images abort the backup so incomplete
      // bundles can never appear as complete successful backups.
      await fs.copyFile(path.join(photosDir,row.filename),path.join(pending,'photos',row.filename));
      try {
        await fs.copyFile(path.join(thumbnailsDir,row.filename),path.join(pending,'thumbnails',row.filename));
      }catch(error){if(error.code!=='ENOENT')throw error;}
      count++;
    }
    // The shared display profiles live in SQLite, while custom logos are
    // separate local files. Keep both with every complete backup.
    const copiedLogos=[];
    for(const area of ['general','contest']){
      const file='screen-logo-'+area+'.webp';
      try{
        await fs.copyFile(path.join(DATA,file),path.join(pending,file));
        copiedLogos.push(file);
      }catch(error){if(error.code!=='ENOENT')throw error;}
    }
    await fs.writeFile(path.join(pending,'manifest.json'),JSON.stringify({
      format:'bali-photo-wall-v1',createdAt:new Date().toISOString(),photos:count,screenLogos:copiedLogos
    },null,2)+'\n');
    await fs.rename(pending,completed);
    console.log('BALI PHOTO WALL backup complete:',completed,'photos:',count);
  }catch(error){
    await fs.rm(pending,{recursive:true,force:true});
    throw error;
  }finally {database?.close();}
}
backup().catch(error=>{console.error('Backup failed:',error.message);process.exitCode=1;});

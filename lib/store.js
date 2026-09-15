// Persistence: JSON database with atomic writes, a process-wide mutation mutex,
// binary image storage via tmp+rename, and startup reconciliation so a crash
// never leaves half-written images, dangling mosaics, or corrupt JSON.
import { mkdir, readFile, writeFile, rename, readdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";

// A slice id is a laboratory label. Allow Unicode letters/numbers and a small
// punctuation set, but never path separators, parent references, dotfiles (which
// would collide with staging filenames), NUL, or other control characters — so
// an id can never encode a path that leaves the images directory.
export function isValidSliceId(id) {
  if (typeof id !== "string" || id.length === 0 || id.length > 64) return false;
  if (id.startsWith(".")) return false; // blocks "." and ".." and dotfiles
  if (id.includes("\\") || id.includes("/")) return false; // no path separators
  for (const ch of id) {
    const cp = ch.codePointAt(0);
    if (cp < 0x20 || cp === 0x7f) return false; // no NUL / control chars
  }
  return /^[\p{L}\p{N}_][\p{L}\p{N} _.-]*$/u.test(id);
}

// Defence in depth: even with an allowed charset, assert that every resolved
// image path stays inside the images directory.
export class PathEscapeError extends Error {
  constructor() {
    super("path_outside_images_dir");
    this.code = "path_outside_images_dir";
  }
}

// Raised when a legacy database contains a slice id shared by more than one
// sample (or duplicated within one). The server must refuse to serve such data
// because microscopy routes resolve slices by id alone.
export class SliceKeyConflict extends Error {
  constructor(conflicts) {
    super("duplicate_slice_keys");
    this.code = "duplicate_slice_keys";
    this.conflicts = conflicts;
  }
}

// Read-only scan of an already-parsed database: group every slice id with more
// than one owning sample. Never touches the filesystem.
export function findSliceKeyConflicts(db) {
  const owners = new Map(); // sliceId -> [{sample, index}]
  for (const sample of db.samples || []) {
    (sample.slices || []).forEach((slice, index) => {
      if (!owners.has(slice.id)) owners.set(slice.id, []);
      owners.get(slice.id).push({ sampleId: sample.id, index });
    });
  }
  const conflicts = [];
  for (const [sliceId, occurrences] of owners) {
    if (occurrences.length > 1) {
      conflicts.push({ sliceId, count: occurrences.length, sampleIds: occurrences.map(o => o.sampleId) });
    }
  }
  return conflicts;
}

export class Store {
  constructor(dataDir, dbFile, seed) {
    this.dataDir = dataDir;
    this.imagesDir = join(dataDir, "images");
    this.dbPath = join(dataDir, dbFile);
    this.seed = seed;
    this.db = null;
    this.queue = Promise.resolve();
  }

  async init() {
    if (!existsSync(this.dbPath)) {
      // Fresh install: seed the database once. This is the only init-time write.
      await mkdir(dirname(this.dbPath), { recursive: true });
      await writeFile(this.dbPath, JSON.stringify(this.seed, null, 2));
    }
    this.db = JSON.parse(await readFile(this.dbPath, "utf8"));

    // Validate before touching anything else. A legacy DB with duplicate slice
    // ids must stop startup; we must not reconcile (which deletes orphans) or
    // rewrite any database/image/mosaic/measurement data.
    const conflicts = findSliceKeyConflicts(this.db);
    if (conflicts.length) throw new SliceKeyConflict(conflicts);

    await mkdir(this.imagesDir, { recursive: true });
    await this.reconcile();
  }

  // Serialise every mutating transaction; same-FOV concurrent uploads are
  // therefore decided strictly one at a time.
  async withLock(fn) {
    const run = this.queue.then(() => fn(this.db));
    // Keep the chain alive regardless of the previous result.
    this.queue = run.then(() => {}, () => {});
    return run;
  }

  // Write JSON to a temp file then rename: readers never observe a torn write.
  async flush() {
    const tmp = `${this.dbPath}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify(this.db, null, 2));
    await rename(tmp, this.dbPath);
  }

  // Resolve and verify a path is contained in the images directory.
  contain(p) {
    const root = resolve(this.imagesDir);
    const target = resolve(p);
    if (target !== root && !relative(root, target).startsWith("..") && !isAbsolute(relative(root, target))) {
      return target;
    }
    throw new PathEscapeError();
  }

  ensureSliceId(sliceId) {
    if (!isValidSliceId(sliceId)) throw new PathEscapeError();
    const dir = this.contain(join(this.imagesDir, sliceId));
    return dir;
  }

  sliceDir(sliceId) {
    return this.ensureSliceId(sliceId);
  }

  tilePath(sliceId, key) {
    // key is always server-generated as "<row>-<col>"; assert it cannot traverse.
    if (!/^\d+-\d+$/.test(String(key))) throw new PathEscapeError();
    return this.contain(join(this.imagesDir, sliceId, `tile-${key}.png`));
  }

  mosaicPath(sliceId) {
    return this.contain(join(this.imagesDir, sliceId, "mosaic.png"));
  }

  privateStagePath(sliceId, tag) {
    if (!/^[\w-]{1,24}$/.test(tag)) throw new PathEscapeError();
    return this.contain(join(this.imagesDir, sliceId, `.stage-${tag}-${process.pid}-${this.uploadSeq()}`));
  }

  // Write bytes to a private temp file, then atomically rename to the destination.
  async saveImage(sliceId, kind, key, buffer) {
    const dir = this.sliceDir(sliceId);
    await mkdir(dir, { recursive: true });
    const finalPath = kind === "mosaic" ? this.mosaicPath(sliceId) : this.tilePath(sliceId, key);
    const tmp = `${finalPath}.upload-${process.pid}-${this.uploadSeq()}`;
    await writeFile(tmp, buffer);
    await rename(tmp, finalPath);
    return finalPath;
  }

  // Two-phase mosaic replacement so a failure (or crash) never destroys the
  // previous valid mosaic: stage new bytes, back up old, commit, clean backup.
  async stageMosaic(sliceId, buffer) {
    const dir = this.sliceDir(sliceId);
    await mkdir(dir, { recursive: true });
    const stage = this.privateStagePath(sliceId, "mosaic");
    await writeFile(stage, buffer);
    return stage;
  }

  async commitMosaic(sliceId, stage) {
    const finalPath = this.mosaicPath(sliceId);
    const backup = this.privateStagePath(sliceId, "backup");
    let hadBackup = false;
    if (existsSync(finalPath)) {
      await rename(finalPath, backup);
      hadBackup = true;
    }
    await rename(stage, finalPath);
    return { backup: hadBackup ? backup : null };
  }

  async finishMosaicCommit(sliceId, backup) {
    if (backup) await unlink(backup).catch(() => {});
  }

  async abortMosaicCommit(sliceId, backup) {
    const finalPath = this.mosaicPath(sliceId);
    if (backup) {
      await unlink(finalPath).catch(() => {});
      await rename(backup, finalPath).catch(() => {});
    } else {
      await this.removeImage(finalPath);
    }
  }

  uploadSeq() {
    this._seq = (this._seq || 0) + 1;
    return this._seq;
  }

  tileBackupPath(sliceId, key) {
    if (!/^\d+-\d+$/.test(String(key))) throw new PathEscapeError();
    return this.contain(join(this.imagesDir, sliceId, `.stage-tile-backup-${key}-${process.pid}-${this.uploadSeq()}`));
  }

  async removeImage(pathLike) {
    try { await unlink(pathLike); } catch { /* already gone */ }
  }

  // Clean tmp leftovers and any files the database no longer references.
  async reconcile() {
    let entries = [];
    try { entries = await readdir(this.imagesDir); } catch { return; }
    for (const sliceId of entries) {
      // Directory names come from disk: resolve safely instead of trusting them
      // as valid ids. Anything escaping images/ is impossible here, but ids that
      // merely fail the charset are still reconciled (cleaned up).
      const dir = this.contain(join(this.imagesDir, sliceId));
      const slice = isValidSliceId(sliceId) ? this.findSlice(sliceId)?.slice : null;
      let files = [];
      try { files = await readdir(dir); } catch { continue; }
      // Crash recovery for two-phase replacement. The DB is the source of truth:
      // whenever a pre-transaction backup exists, restore it over mosaic.png so
      // image bytes can never run ahead of (or behind) the committed DB state.
      const backups = files.filter(f => f.startsWith(".stage-backup-"));
      const stages = files.filter(f => f.startsWith(".stage-mosaic-"));
      if (backups[0]) {
        await unlink(join(dir, "mosaic.png")).catch(() => {});
        await rename(join(dir, backups[0]), join(dir, "mosaic.png")).catch(() => {});
        for (const extra of backups.slice(1)) await unlink(join(dir, extra)).catch(() => {});
      }
      for (const stage of stages) await unlink(join(dir, stage)).catch(() => {});
      // Recover a tile-deletion that moved the file aside but never flushed.
      const tileBackups = files.filter(f => f.startsWith(".stage-tile-backup-"));
      for (const tb of tileBackups) {
        const m = /^\.stage-tile-backup-(.+)-\d+-\d+$/.exec(tb);
        const key = m ? m[1] : null;
        const stillReferenced = key && slice?.micro?.tiles.some(t => t.key === key);
        if (stillReferenced && !files.includes(`tile-${key}.png`)) {
          await rename(join(dir, tb), join(dir, `tile-${key}.png`)).catch(() => unlink(join(dir, tb)).catch(() => {}));
        } else {
          await unlink(join(dir, tb)).catch(() => {});
        }
      }
      if (backups.length || stages.length || tileBackups.length) {
        files = await readdir(dir).catch(() => []);
      }
      for (const file of files) {
        const full = join(dir, file);
        if (file.startsWith(".stage-") || file.endsWith(".tmp") || file.includes(".upload-")) {
          await this.removeImage(full);
          continue;
        }
        if (!slice) { await this.removeImage(full); continue; }
        const micro = slice.micro;
        if (file === "mosaic.png") {
          if (!micro?.mosaic) await this.removeImage(full);
        } else if (file.startsWith("tile-") && file.endsWith(".png")) {
          const key = file.slice(5, -4);
          if (!micro?.tiles.some(t => t.key === key)) await this.removeImage(full);
        }
      }
    }
  }

  findSlice(sliceId) {
    for (const sample of this.db.samples) {
      const slice = sample.slices.find(s => s.id === sliceId);
      if (slice) return { sample, slice };
    }
    return null;
  }
}

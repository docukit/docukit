/**
 * IndexedDB Multi-User Architecture Benchmarks
 *
 * To run this benchmark:
 * - pnpm vitest bench --project browser
 *
 * This benchmark compares three multi-user IndexedDB architectures:
 * 1. Separate databases per user
 * 2. Separate object stores per user (same database)
 * 3. Single object store with userId in values
 *
 * Also measures:
 * - DB/ObjectStore creation and connection costs
 * - How read/write performance scales with data growth
 * - Query performance differences
 */

import { bench, describe } from "vitest";

// ============================================================================
// HELPERS
// ============================================================================

const DB_PREFIX = "bench_idb_";
let dbCounter = 0;

function uniqueDbName(base: string): string {
  return `${DB_PREFIX}${base}_${Date.now()}_${dbCounter++}`;
}

function openDatabase(
  name: string,
  storeNames: string[] = ["data"],
  version = 1,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const storeName of storeNames) {
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName, { keyPath: "id" });
        }
      }
    };
  });
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

async function writeRecord(
  db: IDBDatabase,
  storeName: string,
  record: { id: string; [key: string]: unknown },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    const request = store.put(record);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

async function readRecord(
  db: IDBDatabase,
  storeName: string,
  id: string,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const request = store.get(id);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

async function getAllRecords(
  db: IDBDatabase,
  storeName: string,
): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const request = store.getAll();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result as unknown[]);
  });
}

async function writeBatch(
  db: IDBDatabase,
  storeName: string,
  records: { id: string; [key: string]: unknown }[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    for (const record of records) {
      store.put(record);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Cleanup helper
const dbsToCleanup: string[] = [];
async function cleanup() {
  for (const name of dbsToCleanup) {
    try {
      await deleteDatabase(name);
    } catch {
      // ignore
    }
  }
  dbsToCleanup.length = 0;
}

// ============================================================================
// BENCHMARKS
// ============================================================================

// ----------------------------------------------------------------------------
// 1. Database/ObjectStore Creation and Connection Costs
// ----------------------------------------------------------------------------

describe("DB/ObjectStore Creation Costs", () => {
  bench("create new database (1 store)", async () => {
    const name = uniqueDbName("create_single");
    dbsToCleanup.push(name);
    const db = await openDatabase(name, ["store1"]);
    db.close();
  });

  bench("create new database (5 stores)", async () => {
    const name = uniqueDbName("create_5stores");
    dbsToCleanup.push(name);
    const db = await openDatabase(name, [
      "store1",
      "store2",
      "store3",
      "store4",
      "store5",
    ]);
    db.close();
  });

  bench("create new database (20 stores)", async () => {
    const name = uniqueDbName("create_20stores");
    dbsToCleanup.push(name);
    const stores = Array.from({ length: 20 }, (_, i) => `store${i}`);
    const db = await openDatabase(name, stores);
    db.close();
  });

  bench("connect to existing database", async () => {
    const name = uniqueDbName("existing");
    dbsToCleanup.push(name);
    // Create once
    const dbInit = await openDatabase(name, ["store1"]);
    dbInit.close();

    // Benchmark reconnection
    const db = await openDatabase(name, ["store1"]);
    db.close();
  });
});

// ----------------------------------------------------------------------------
// 2. Write Performance: Architecture Comparison
// ----------------------------------------------------------------------------

describe("Write: Single record per user", () => {
  const USERS = 10;
  const RECORDS_PER_USER = 100;

  // Architecture A: Separate DBs
  bench("separate DBs (10 users × 100 records)", async () => {
    const dbs: IDBDatabase[] = [];

    for (let u = 0; u < USERS; u++) {
      const name = uniqueDbName(`write_sepdb_u${u}`);
      dbsToCleanup.push(name);
      const db = await openDatabase(name, ["data"]);
      dbs.push(db);

      for (let r = 0; r < RECORDS_PER_USER; r++) {
        await writeRecord(db, "data", {
          id: `record_${r}`,
          value: `data for user ${u} record ${r}`,
          timestamp: Date.now(),
        });
      }
    }

    for (const db of dbs) db.close();
  });

  // Architecture B: Separate ObjectStores
  bench("separate ObjectStores (10 users × 100 records)", async () => {
    const storeNames = Array.from({ length: USERS }, (_, i) => `user_${i}`);
    const name = uniqueDbName("write_sepstore");
    dbsToCleanup.push(name);
    const db = await openDatabase(name, storeNames);

    for (let u = 0; u < USERS; u++) {
      const storeName = `user_${u}`;
      for (let r = 0; r < RECORDS_PER_USER; r++) {
        await writeRecord(db, storeName, {
          id: `record_${r}`,
          value: `data for user ${u} record ${r}`,
          timestamp: Date.now(),
        });
      }
    }

    db.close();
  });

  // Architecture C: Single ObjectStore with userId
  bench("single ObjectStore with userId (10 users × 100 records)", async () => {
    const name = uniqueDbName("write_single");
    dbsToCleanup.push(name);
    const db = await openDatabase(name, ["data"]);

    for (let u = 0; u < USERS; u++) {
      for (let r = 0; r < RECORDS_PER_USER; r++) {
        await writeRecord(db, "data", {
          id: `user_${u}_record_${r}`,
          userId: u,
          value: `data for user ${u} record ${r}`,
          timestamp: Date.now(),
        });
      }
    }

    db.close();
  });
});

// ----------------------------------------------------------------------------
// 3. Batch Write Performance
// ----------------------------------------------------------------------------

describe("Batch Write Performance", () => {
  const BATCH_SIZE = 1000;

  bench("single transaction: 1000 records", async () => {
    const name = uniqueDbName("batch_1k");
    dbsToCleanup.push(name);
    const db = await openDatabase(name, ["data"]);

    const records = Array.from({ length: BATCH_SIZE }, (_, i) => ({
      id: `record_${i}`,
      value: `data ${i}`,
      timestamp: Date.now(),
    }));

    await writeBatch(db, "data", records);
    db.close();
  });

  bench("individual transactions: 1000 records", async () => {
    const name = uniqueDbName("individual_1k");
    dbsToCleanup.push(name);
    const db = await openDatabase(name, ["data"]);

    for (let i = 0; i < BATCH_SIZE; i++) {
      await writeRecord(db, "data", {
        id: `record_${i}`,
        value: `data ${i}`,
        timestamp: Date.now(),
      });
    }

    db.close();
  });
});

// ----------------------------------------------------------------------------
// 4. Read Performance: Architecture Comparison
// ----------------------------------------------------------------------------

describe("Read: Get single record by ID", () => {
  const USERS = 10;
  const RECORDS_PER_USER = 100;
  const READ_ITERATIONS = 50;

  // Setup DBs for reading
  let separateDbNames: string[] = [];
  let separateDbs: IDBDatabase[] = [];
  let separateStoreDb: IDBDatabase | null = null;
  let singleStoreDb: IDBDatabase | null = null;
  const separateStoreDbName = uniqueDbName("read_sepstore_setup");
  const singleStoreDbName = uniqueDbName("read_single_setup");

  // Pre-populate databases before benchmarks
  bench("SETUP: populate separate DBs", async () => {
    separateDbNames = [];
    separateDbs = [];

    for (let u = 0; u < USERS; u++) {
      const name = uniqueDbName(`read_sepdb_u${u}`);
      separateDbNames.push(name);
      dbsToCleanup.push(name);
      const db = await openDatabase(name, ["data"]);
      separateDbs.push(db);

      const records = Array.from({ length: RECORDS_PER_USER }, (_, r) => ({
        id: `record_${r}`,
        value: `data for user ${u} record ${r}`,
      }));
      await writeBatch(db, "data", records);
    }
  });

  bench("SETUP: populate separate ObjectStores", async () => {
    const storeNames = Array.from({ length: USERS }, (_, i) => `user_${i}`);
    dbsToCleanup.push(separateStoreDbName);
    separateStoreDb = await openDatabase(separateStoreDbName, storeNames);

    for (let u = 0; u < USERS; u++) {
      const records = Array.from({ length: RECORDS_PER_USER }, (_, r) => ({
        id: `record_${r}`,
        value: `data for user ${u} record ${r}`,
      }));
      await writeBatch(separateStoreDb, `user_${u}`, records);
    }
  });

  bench("SETUP: populate single ObjectStore", async () => {
    dbsToCleanup.push(singleStoreDbName);
    singleStoreDb = await openDatabase(singleStoreDbName, ["data"]);

    const records = [];
    for (let u = 0; u < USERS; u++) {
      for (let r = 0; r < RECORDS_PER_USER; r++) {
        records.push({
          id: `user_${u}_record_${r}`,
          userId: u,
          value: `data for user ${u} record ${r}`,
        });
      }
    }
    await writeBatch(singleStoreDb, "data", records);
  });

  bench("separate DBs: random reads", async () => {
    for (let i = 0; i < READ_ITERATIONS; i++) {
      const userIdx = Math.floor(Math.random() * USERS);
      const recordIdx = Math.floor(Math.random() * RECORDS_PER_USER);
      await readRecord(separateDbs[userIdx]!, "data", `record_${recordIdx}`);
    }
  });

  bench("separate ObjectStores: random reads", async () => {
    for (let i = 0; i < READ_ITERATIONS; i++) {
      const userIdx = Math.floor(Math.random() * USERS);
      const recordIdx = Math.floor(Math.random() * RECORDS_PER_USER);
      await readRecord(
        separateStoreDb!,
        `user_${userIdx}`,
        `record_${recordIdx}`,
      );
    }
  });

  bench("single ObjectStore: random reads", async () => {
    for (let i = 0; i < READ_ITERATIONS; i++) {
      const userIdx = Math.floor(Math.random() * USERS);
      const recordIdx = Math.floor(Math.random() * RECORDS_PER_USER);
      await readRecord(
        singleStoreDb!,
        "data",
        `user_${userIdx}_record_${recordIdx}`,
      );
    }
  });

  bench("CLEANUP: close DBs", async () => {
    for (const db of separateDbs) db.close();
    separateStoreDb?.close();
    singleStoreDb?.close();
  });
});

// ----------------------------------------------------------------------------
// 5. getAll Performance: Architecture Comparison
// ----------------------------------------------------------------------------

describe("Read: getAll for single user", () => {
  const USERS = 10;
  const RECORDS_PER_USER = 500;

  bench("separate DBs: getAll (500 records)", async () => {
    const name = uniqueDbName("getall_sepdb");
    dbsToCleanup.push(name);
    const db = await openDatabase(name, ["data"]);

    const records = Array.from({ length: RECORDS_PER_USER }, (_, i) => ({
      id: `record_${i}`,
      value: `data ${i}`,
    }));
    await writeBatch(db, "data", records);

    await getAllRecords(db, "data");
    db.close();
  });

  bench("separate ObjectStores: getAll (500 records)", async () => {
    const storeNames = Array.from({ length: USERS }, (_, i) => `user_${i}`);
    const name = uniqueDbName("getall_sepstore");
    dbsToCleanup.push(name);
    const db = await openDatabase(name, storeNames);

    const records = Array.from({ length: RECORDS_PER_USER }, (_, i) => ({
      id: `record_${i}`,
      value: `data ${i}`,
    }));
    await writeBatch(db, "user_0", records);

    await getAllRecords(db, "user_0");
    db.close();
  });

  bench("single ObjectStore: getAll + filter (500/5000 records)", async () => {
    const name = uniqueDbName("getall_single");
    dbsToCleanup.push(name);
    const db = await openDatabase(name, ["data"]);

    // Write 5000 total records (500 per user × 10 users)
    const allRecords = [];
    for (let u = 0; u < USERS; u++) {
      for (let r = 0; r < RECORDS_PER_USER; r++) {
        allRecords.push({
          id: `user_${u}_record_${r}`,
          userId: u,
          value: `data ${r}`,
        });
      }
    }
    await writeBatch(db, "data", allRecords);

    // Read all and filter for user_0
    const all = (await getAllRecords(db, "data")) as { userId: number }[];
    all.filter((r) => r.userId === 0);
    db.close();
  });
});

// ----------------------------------------------------------------------------
// 6. Scaling: How performance degrades with data growth
// ----------------------------------------------------------------------------

describe("Scaling: Record count growth", () => {
  bench("write 100 records to empty store", async () => {
    const name = uniqueDbName("scale_100");
    dbsToCleanup.push(name);
    const db = await openDatabase(name, ["data"]);

    const records = Array.from({ length: 100 }, (_, i) => ({
      id: `record_${i}`,
      value: `data ${i}`.repeat(10),
    }));
    await writeBatch(db, "data", records);
    db.close();
  });

  bench("write 100 records to store with 1000 existing", async () => {
    const name = uniqueDbName("scale_1100");
    dbsToCleanup.push(name);
    const db = await openDatabase(name, ["data"]);

    // Pre-populate with 1000 records
    const existing = Array.from({ length: 1000 }, (_, i) => ({
      id: `existing_${i}`,
      value: `data ${i}`.repeat(10),
    }));
    await writeBatch(db, "data", existing);

    // Benchmark writing 100 more
    const records = Array.from({ length: 100 }, (_, i) => ({
      id: `new_${i}`,
      value: `data ${i}`.repeat(10),
    }));
    await writeBatch(db, "data", records);
    db.close();
  });

  bench("write 100 records to store with 10000 existing", async () => {
    const name = uniqueDbName("scale_10100");
    dbsToCleanup.push(name);
    const db = await openDatabase(name, ["data"]);

    // Pre-populate with 10000 records
    const existing = Array.from({ length: 10000 }, (_, i) => ({
      id: `existing_${i}`,
      value: `data ${i}`.repeat(10),
    }));
    await writeBatch(db, "data", existing);

    // Benchmark writing 100 more
    const records = Array.from({ length: 100 }, (_, i) => ({
      id: `new_${i}`,
      value: `data ${i}`.repeat(10),
    }));
    await writeBatch(db, "data", records);
    db.close();
  });
});

describe("Scaling: Read from different store sizes", () => {
  bench("read 50 random records from 100 total", async () => {
    const name = uniqueDbName("read_100");
    dbsToCleanup.push(name);
    const db = await openDatabase(name, ["data"]);

    const records = Array.from({ length: 100 }, (_, i) => ({
      id: `record_${i}`,
      value: `data ${i}`,
    }));
    await writeBatch(db, "data", records);

    for (let i = 0; i < 50; i++) {
      const idx = Math.floor(Math.random() * 100);
      await readRecord(db, "data", `record_${idx}`);
    }
    db.close();
  });

  bench("read 50 random records from 10000 total", async () => {
    const name = uniqueDbName("read_10000");
    dbsToCleanup.push(name);
    const db = await openDatabase(name, ["data"]);

    const records = Array.from({ length: 10000 }, (_, i) => ({
      id: `record_${i}`,
      value: `data ${i}`,
    }));
    await writeBatch(db, "data", records);

    for (let i = 0; i < 50; i++) {
      const idx = Math.floor(Math.random() * 10000);
      await readRecord(db, "data", `record_${idx}`);
    }
    db.close();
  });

  bench("read 50 random records from 50000 total", async () => {
    const name = uniqueDbName("read_50000");
    dbsToCleanup.push(name);
    const db = await openDatabase(name, ["data"]);

    const records = Array.from({ length: 50000 }, (_, i) => ({
      id: `record_${i}`,
      value: `data ${i}`,
    }));
    await writeBatch(db, "data", records);

    for (let i = 0; i < 50; i++) {
      const idx = Math.floor(Math.random() * 50000);
      await readRecord(db, "data", `record_${idx}`);
    }
    db.close();
  });
});

// ----------------------------------------------------------------------------
// 7. Multiple DB connections overhead
// ----------------------------------------------------------------------------

describe("Connection overhead: Multiple open DBs", () => {
  bench("open and read from 1 DB", async () => {
    const name = uniqueDbName("conn_1");
    dbsToCleanup.push(name);
    const db = await openDatabase(name, ["data"]);
    await writeRecord(db, "data", { id: "test", value: "data" });
    await readRecord(db, "data", "test");
    db.close();
  });

  bench("open and read from 5 DBs sequentially", async () => {
    const dbs: IDBDatabase[] = [];
    for (let i = 0; i < 5; i++) {
      const name = uniqueDbName(`conn_5_${i}`);
      dbsToCleanup.push(name);
      const db = await openDatabase(name, ["data"]);
      dbs.push(db);
      await writeRecord(db, "data", { id: "test", value: "data" });
    }

    for (const db of dbs) {
      await readRecord(db, "data", "test");
    }

    for (const db of dbs) db.close();
  });

  bench("open and read from 20 DBs sequentially", async () => {
    const dbs: IDBDatabase[] = [];
    for (let i = 0; i < 20; i++) {
      const name = uniqueDbName(`conn_20_${i}`);
      dbsToCleanup.push(name);
      const db = await openDatabase(name, ["data"]);
      dbs.push(db);
      await writeRecord(db, "data", { id: "test", value: "data" });
    }

    for (const db of dbs) {
      await readRecord(db, "data", "test");
    }

    for (const db of dbs) db.close();
  });
});

// ----------------------------------------------------------------------------
// 8. Index-based querying (for single store + userId approach)
// ----------------------------------------------------------------------------

describe("Index-based query for userId", () => {
  function openDatabaseWithIndex(name: string): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      request.onupgradeneeded = () => {
        const db = request.result;
        const store = db.createObjectStore("data", { keyPath: "id" });
        store.createIndex("userId", "userId", { unique: false });
      };
    });
  }

  async function getByUserIdIndex(
    db: IDBDatabase,
    userId: number,
  ): Promise<unknown[]> {
    return new Promise((resolve, reject) => {
      const tx = db.transaction("data", "readonly");
      const store = tx.objectStore("data");
      const index = store.index("userId");
      const request = index.getAll(userId);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result as unknown[]);
    });
  }

  const USERS = 10;
  const RECORDS_PER_USER = 500;

  bench("query by userId using index", async () => {
    const name = uniqueDbName("idx_query");
    dbsToCleanup.push(name);
    const db = await openDatabaseWithIndex(name);

    // Populate
    const allRecords = [];
    for (let u = 0; u < USERS; u++) {
      for (let r = 0; r < RECORDS_PER_USER; r++) {
        allRecords.push({
          id: `user_${u}_record_${r}`,
          userId: u,
          value: `data ${r}`,
        });
      }
    }
    await writeBatch(db, "data", allRecords);

    // Query for single user
    await getByUserIdIndex(db, 5);
    db.close();
  });

  bench("query by userId using getAll + filter", async () => {
    const name = uniqueDbName("filter_query");
    dbsToCleanup.push(name);
    const db = await openDatabase(name, ["data"]);

    // Populate
    const allRecords = [];
    for (let u = 0; u < USERS; u++) {
      for (let r = 0; r < RECORDS_PER_USER; r++) {
        allRecords.push({
          id: `user_${u}_record_${r}`,
          userId: u,
          value: `data ${r}`,
        });
      }
    }
    await writeBatch(db, "data", allRecords);

    // Query for single user
    const all = (await getAllRecords(db, "data")) as { userId: number }[];
    all.filter((r) => r.userId === 5);
    db.close();
  });

  bench("query from dedicated objectStore (baseline)", async () => {
    const storeNames = Array.from({ length: USERS }, (_, i) => `user_${i}`);
    const name = uniqueDbName("dedicated_query");
    dbsToCleanup.push(name);
    const db = await openDatabase(name, storeNames);

    // Populate user_5 only
    const records = Array.from({ length: RECORDS_PER_USER }, (_, r) => ({
      id: `record_${r}`,
      value: `data ${r}`,
    }));
    await writeBatch(db, "user_5", records);

    // Query for user_5
    await getAllRecords(db, "user_5");
    db.close();
  });
});

// ----------------------------------------------------------------------------
// 9. Delete performance
// ----------------------------------------------------------------------------

describe("Delete performance", () => {
  async function deleteRecord(
    db: IDBDatabase,
    storeName: string,
    id: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      const request = store.delete(id);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  async function clearStore(db: IDBDatabase, storeName: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      const request = store.clear();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  bench("delete 100 individual records", async () => {
    const name = uniqueDbName("del_individual");
    dbsToCleanup.push(name);
    const db = await openDatabase(name, ["data"]);

    const records = Array.from({ length: 100 }, (_, i) => ({
      id: `record_${i}`,
      value: `data ${i}`,
    }));
    await writeBatch(db, "data", records);

    for (let i = 0; i < 100; i++) {
      await deleteRecord(db, "data", `record_${i}`);
    }
    db.close();
  });

  bench("clear entire store (1000 records)", async () => {
    const name = uniqueDbName("del_clear");
    dbsToCleanup.push(name);
    const db = await openDatabase(name, ["data"]);

    const records = Array.from({ length: 1000 }, (_, i) => ({
      id: `record_${i}`,
      value: `data ${i}`,
    }));
    await writeBatch(db, "data", records);

    await clearStore(db, "data");
    db.close();
  });

  bench("delete database (user removal scenario)", async () => {
    const name = uniqueDbName("del_db");
    // Don't add to cleanup, we're deleting it ourselves
    const db = await openDatabase(name, ["data"]);

    const records = Array.from({ length: 1000 }, (_, i) => ({
      id: `record_${i}`,
      value: `data ${i}`,
    }));
    await writeBatch(db, "data", records);
    db.close();

    await deleteDatabase(name);
  });
});

// ----------------------------------------------------------------------------
// 10. Realistic scenario: User switching
// ----------------------------------------------------------------------------

describe("Realistic: User switching cost", () => {
  const RECORDS_PER_USER = 200;

  bench("separate DBs: switch user (close + open + load)", async () => {
    // Setup user1 DB
    const name1 = uniqueDbName("switch_db1");
    const name2 = uniqueDbName("switch_db2");
    dbsToCleanup.push(name1, name2);

    const db1 = await openDatabase(name1, ["data"]);
    const records1 = Array.from({ length: RECORDS_PER_USER }, (_, i) => ({
      id: `record_${i}`,
      value: `user1 data ${i}`,
    }));
    await writeBatch(db1, "data", records1);

    const db2 = await openDatabase(name2, ["data"]);
    const records2 = Array.from({ length: RECORDS_PER_USER }, (_, i) => ({
      id: `record_${i}`,
      value: `user2 data ${i}`,
    }));
    await writeBatch(db2, "data", records2);
    db2.close();

    // Simulate switch: close db1, open db2, load all data
    db1.close();
    const switchedDb = await openDatabase(name2, ["data"]);
    await getAllRecords(switchedDb, "data");
    switchedDb.close();
  });

  bench("separate ObjectStores: switch user (same DB, load)", async () => {
    const name = uniqueDbName("switch_store");
    dbsToCleanup.push(name);

    const db = await openDatabase(name, ["user1", "user2"]);

    const records1 = Array.from({ length: RECORDS_PER_USER }, (_, i) => ({
      id: `record_${i}`,
      value: `user1 data ${i}`,
    }));
    await writeBatch(db, "user1", records1);

    const records2 = Array.from({ length: RECORDS_PER_USER }, (_, i) => ({
      id: `record_${i}`,
      value: `user2 data ${i}`,
    }));
    await writeBatch(db, "user2", records2);

    // Simulate switch: just load from different store
    await getAllRecords(db, "user2");
    db.close();
  });

  bench("single ObjectStore: switch user (query by userId)", async () => {
    const name = uniqueDbName("switch_single");
    dbsToCleanup.push(name);

    const db = await openDatabase(name, ["data"]);

    const allRecords = [];
    for (let u = 0; u < 2; u++) {
      for (let r = 0; r < RECORDS_PER_USER; r++) {
        allRecords.push({
          id: `user_${u}_record_${r}`,
          userId: u,
          value: `user${u} data ${r}`,
        });
      }
    }
    await writeBatch(db, "data", allRecords);

    // Simulate switch: getAll and filter
    const all = (await getAllRecords(db, "data")) as { userId: number }[];
    all.filter((r) => r.userId === 1);
    db.close();
  });
});

// Final cleanup
describe("CLEANUP", () => {
  bench("cleanup all test databases", async () => {
    await cleanup();
  });
});

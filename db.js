const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const DATA_DIR = __dirname;
const PLATFORM_DB_PATH = path.join(DATA_DIR, 'platform.db');

// Main Platform Database
let platformDb;

function initPlatformDb() {
  return new Promise((resolve, reject) => {
    platformDb = new sqlite3.Database(PLATFORM_DB_PATH, (err) => {
      if (err) {
        console.error('Failed to connect to platform database:', err);
        return reject(err);
      }
      console.log('Connected to platform database.');
      
      // Create tenants and users tables
      platformDb.serialize(() => {
        platformDb.run(`
          CREATE TABLE IF NOT EXISTS tenants (
            id TEXT PRIMARY KEY,
            business_name TEXT NOT NULL,
            domain TEXT UNIQUE NOT NULL,
            email TEXT,
            phone TEXT,
            status TEXT CHECK(status IN ('PENDING', 'ACTIVE', 'SUSPENDED')) DEFAULT 'PENDING',
            stripe_account_id TEXT UNIQUE,
            subscription_tier TEXT CHECK(subscription_tier IN ('BASIC', 'PREMIUM', 'ENTERPRISE')) NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);

        platformDb.run(`
          CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            tenant_id TEXT, -- NULL for Platform Admin / standalone Consumers
            email TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT CHECK(role IN ('PLATFORM_ADMIN', 'TENANT_ADMIN', 'TENANT_STAFF', 'DRIVER', 'CONSUMER')) NOT NULL,
            first_name TEXT NOT NULL,
            last_name TEXT NOT NULL,
            phone TEXT NOT NULL,
            address TEXT,
            status TEXT CHECK(status IN ('ACTIVE', 'INACTIVE')) DEFAULT 'ACTIVE',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
            UNIQUE(email, tenant_id)
          )
        `, (err) => {
          if (err) reject(err);
          else resolve(platformDb);
        });
      });
    });
  });
}

// Active Tenant Database Connections cache
const tenantDbCache = {};

function getTenantDbPath(tenantId) {
  return path.join(DATA_DIR, `tenant_${tenantId}.db`);
}

function getTenantDb(tenantId) {
  return new Promise((resolve, reject) => {
    if (tenantDbCache[tenantId]) {
      return resolve(tenantDbCache[tenantId]);
    }

    const dbPath = getTenantDbPath(tenantId);
    const dbExists = fs.existsSync(dbPath);

    const db = new sqlite3.Database(dbPath, (err) => {
      if (err) {
        console.error(`Failed to connect to tenant database for ${tenantId}:`, err);
        return reject(err);
      }

      tenantDbCache[tenantId] = db;

      if (!dbExists) {
        console.log(`Initializing new database schema for tenant: ${tenantId}`);
        initializeTenantSchema(db)
          .then(() => resolve(db))
          .catch(reject);
      } else {
        resolve(db);
      }
    });
  });
}

function initializeTenantSchema(db) {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      // 1. Restaurants table
      db.run(`
        CREATE TABLE IF NOT EXISTS restaurants (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          latitude REAL NOT NULL,
          longitude REAL NOT NULL,
          address TEXT NOT NULL,
          contact_phone TEXT,
          status TEXT CHECK(status IN ('OPEN', 'CLOSED', 'PAUSED')) DEFAULT 'OPEN',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // 2. Menu Categories
      db.run(`
        CREATE TABLE IF NOT EXISTS menu_categories (
          id TEXT PRIMARY KEY,
          restaurant_id TEXT NOT NULL,
          name TEXT NOT NULL,
          display_order INTEGER DEFAULT 0,
          FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
        )
      `);

      // 3. Menu Items
      db.run(`
        CREATE TABLE IF NOT EXISTS menu_items (
          id TEXT PRIMARY KEY,
          category_id TEXT NOT NULL,
          name TEXT NOT NULL,
          description TEXT,
          base_price_cents INTEGER NOT NULL,
          discount_price_cents INTEGER DEFAULT NULL,
          is_available BOOLEAN DEFAULT 1,
          dietary_tag TEXT,
          image_url TEXT,
          images TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (category_id) REFERENCES menu_categories(id) ON DELETE CASCADE
        )
      `);

      // 4. Modifier Groups
      db.run(`
        CREATE TABLE IF NOT EXISTS modifier_groups (
          id TEXT PRIMARY KEY,
          menu_item_id TEXT NOT NULL,
          name TEXT NOT NULL,
          min_selection INTEGER DEFAULT 0,
          max_selection INTEGER DEFAULT 1,
          FOREIGN KEY (menu_item_id) REFERENCES menu_items(id) ON DELETE CASCADE
        )
      `);

      // 5. Modifiers
      db.run(`
        CREATE TABLE IF NOT EXISTS modifiers (
          id TEXT PRIMARY KEY,
          modifier_group_id TEXT NOT NULL,
          name TEXT NOT NULL,
          price_cents INTEGER DEFAULT 0,
          is_available BOOLEAN DEFAULT 1,
          FOREIGN KEY (modifier_group_id) REFERENCES modifier_groups(id) ON DELETE CASCADE
        )
      `);

      // 6. Orders
      db.run(`
        CREATE TABLE IF NOT EXISTS orders (
          id TEXT PRIMARY KEY,
          customer_id TEXT NOT NULL,
          restaurant_id TEXT NOT NULL,
          status TEXT CHECK(status IN ('PLACED', 'ACCEPTED', 'PREPARING', 'READY', 'DISPATCHED', 'DELIVERED', 'CANCELLED')) NOT NULL,
          subtotal_cents INTEGER NOT NULL,
          delivery_fee_cents INTEGER DEFAULT 0,
          tax_cents INTEGER DEFAULT 0,
          platform_commission_cents INTEGER DEFAULT 0,
          total_cents INTEGER NOT NULL,
          payment_status TEXT CHECK(payment_status IN ('PENDING', 'PAID', 'REFUNDED', 'FAILED')) DEFAULT 'PENDING',
          payment_method TEXT CHECK(payment_method IN ('CARD', 'UPI', 'COD')) DEFAULT 'CARD',
          delivery_address TEXT NOT NULL,
          delivery_lat REAL NOT NULL,
          delivery_lng REAL NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // 7. Order Items
      db.run(`
        CREATE TABLE IF NOT EXISTS order_items (
          id TEXT PRIMARY KEY,
          order_id TEXT NOT NULL,
          menu_item_id TEXT NOT NULL,
          quantity INTEGER NOT NULL,
          price_cents INTEGER NOT NULL,
          FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
        )
      `);

      // 8. Order Item Modifiers
      db.run(`
        CREATE TABLE IF NOT EXISTS order_item_modifiers (
          id TEXT PRIMARY KEY,
          order_item_id TEXT NOT NULL,
          modifier_id TEXT NOT NULL,
          price_cents INTEGER NOT NULL,
          FOREIGN KEY (order_item_id) REFERENCES order_items(id) ON DELETE CASCADE
        )
      `);

      // 9. Deliveries (Driver assignments and progress)
      db.run(`
        CREATE TABLE IF NOT EXISTS deliveries (
          id TEXT PRIMARY KEY,
          order_id TEXT UNIQUE NOT NULL,
          driver_id TEXT,
          status TEXT CHECK(status IN ('PENDING_ASSIGNMENT', 'ACCEPTED', 'PICKED_UP', 'DELIVERED', 'FAILED')) DEFAULT 'PENDING_ASSIGNMENT',
          assigned_at DATETIME,
          picked_up_at DATETIME,
          delivered_at DATETIME,
          FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
        )
      `, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });
}

// Utility wrapper for running queries in promise form
function dbRun(db, query, params = []) {
  return new Promise((resolve, reject) => {
    db.run(query, params, function(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function dbAll(db, query, params = []) {
  return new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function dbGet(db, query, params = []) {
  return new Promise((resolve, reject) => {
    db.get(query, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

module.exports = {
  initPlatformDb,
  getPlatformDb: () => platformDb,
  getTenantDb,
  dbRun,
  dbAll,
  dbGet
};

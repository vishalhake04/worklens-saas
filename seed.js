const dbManager = require('./db');
const fs = require('fs');
const path = require('path');

// Clean up existing databases to start fresh
const filesToClean = ['platform.db', 'tenant_tenant_1.db', 'tenant_tenant_2.db'];
filesToClean.forEach(f => {
  const p = path.join(__dirname, f);
  if (fs.existsSync(p)) {
    try {
      fs.unlinkSync(p);
      console.log(`Cleaned up old database file: ${f}`);
    } catch (e) {
      console.error(`Could not remove ${f}:`, e.message);
    }
  }
});

async function seed() {
  try {
    console.log('Starting database seeding...');

    // 1. Initialize and get Platform DB connection
    const platformDb = await dbManager.initPlatformDb();

    // 2. Insert tenants
    const insertTenant = `INSERT INTO tenants (id, business_name, domain, email, phone, status, stripe_account_id, subscription_tier) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
    await dbManager.dbRun(platformDb, insertTenant, ['tenant_1', 'Pizza Hub', 'pizzahub.com', 'admin@pizzahub.com', '9876543210', 'ACTIVE', 'acct_stripe_pizzahub', 'PREMIUM']);
    await dbManager.dbRun(platformDb, insertTenant, ['tenant_2', 'Burger Byte', 'burgerbyte.com', 'admin@burgerbyte.com', '8765432109', 'ACTIVE', 'acct_stripe_burgerbyte', 'BASIC']);

    console.log('Seeded tenants.');

    // 3. Insert users (Note: password hash is plaintext for simulation simplicity)
    const insertUser = `INSERT INTO users (id, tenant_id, email, password_hash, role, first_name, last_name, phone, address, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    
    // Platform Admin
    await dbManager.dbRun(platformDb, insertUser, ['usr_platform_admin', null, 'admin@saas.com', 'password123', 'PLATFORM_ADMIN', 'Sarah', 'Connor', '123-456-7890', null, 'ACTIVE']);
    
    // Tenant Admins
    await dbManager.dbRun(platformDb, insertUser, ['usr_tenant_1_admin', 'tenant_1', 'admin@pizzahub.com', 'password123', 'TENANT_ADMIN', 'Mario', 'Rossi', '9876543210', null, 'ACTIVE']);
    await dbManager.dbRun(platformDb, insertUser, ['usr_tenant_2_admin', 'tenant_2', 'admin@burgerbyte.com', 'password123', 'TENANT_ADMIN', 'Bob', 'Burger', '8765432109', null, 'ACTIVE']);
    
    // Consumers
    await dbManager.dbRun(platformDb, insertUser, ['usr_consumer_1', 'tenant_1', 'diner@foodie.com', 'password123', 'CONSUMER', 'John', 'Doe', '222-333-4444', '120 Broadway, New York, NY', 'ACTIVE']);
    await dbManager.dbRun(platformDb, insertUser, ['usr_consumer_2', 'tenant_2', 'diner2@foodie.com', 'password123', 'CONSUMER', 'Alice', 'Smith', '333-444-5555', '250 Main St, New York, NY', 'ACTIVE']);
    
    // Drivers
    await dbManager.dbRun(platformDb, insertUser, ['usr_driver_1', 'tenant_1', 'driver1@delivery.com', 'password123', 'DRIVER', 'Dave', 'Fast', '444-555-6666', null, 'ACTIVE']);
    await dbManager.dbRun(platformDb, insertUser, ['usr_driver_2', 'tenant_2', 'driver2@delivery.com', 'password123', 'DRIVER', 'Dan', 'Quick', '777-888-9999', null, 'ACTIVE']);

    console.log('Seeded users.');

    // 4. Seed Tenant 1 (Pizza Hub) Database
    console.log('Seeding Tenant 1 (Pizza Hub) database...');
    const db1 = await dbManager.getTenantDb('tenant_1');
    
    // Restaurant branch (Downtown, New York)
    await dbManager.dbRun(db1, `INSERT INTO restaurants (id, name, latitude, longitude, address, contact_phone, status) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['rest_1', 'Pizza Hub - Downtown NY', 40.7128, -74.0060, '120 Broadway, New York, NY 10271', '212-555-1234', 'OPEN']
    );

    // Categories
    await dbManager.dbRun(db1, `INSERT INTO menu_categories (id, restaurant_id, name, display_order) VALUES (?, ?, ?, ?)`, ['cat_1_1', 'rest_1', 'Pizzas', 1]);
    await dbManager.dbRun(db1, `INSERT INTO menu_categories (id, restaurant_id, name, display_order) VALUES (?, ?, ?, ?)`, ['cat_1_2', 'rest_1', 'Sides & Drinks', 2]);

    // Menu Items
    await dbManager.dbRun(db1, `INSERT INTO menu_items (id, category_id, name, description, base_price_cents, is_available, dietary_tag, image_url, images) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['item_1_1', 'cat_1_1', 'Margherita Pizza', 'Classic pizza with fresh mozzarella, tomato sauce, and basil', 999, 1, 'VEGETARIAN', 'https://images.unsplash.com/photo-1604382354936-07c5d9983bd3?w=500&auto=format&fit=crop', JSON.stringify(['https://images.unsplash.com/photo-1604382354936-07c5d9983bd3?w=500&auto=format&fit=crop', 'https://images.unsplash.com/photo-1513104890138-7c749659a591?w=500&auto=format&fit=crop', 'https://images.unsplash.com/photo-1590947132387-155cc02f3212?w=500&auto=format&fit=crop'])]
    );
    await dbManager.dbRun(db1, `INSERT INTO menu_items (id, category_id, name, description, base_price_cents, is_available, dietary_tag, image_url, images) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['item_1_2', 'cat_1_1', 'Pepperoni Feast', 'Double pepperoni, loaded cheese, and special herbs', 1349, 1, 'NON-VEG', 'https://images.unsplash.com/photo-1628840042765-356cda07504e?w=500&auto=format&fit=crop', JSON.stringify(['https://images.unsplash.com/photo-1628840042765-356cda07504e?w=500&auto=format&fit=crop', 'https://images.unsplash.com/photo-1534308983496-4fabb1a015ee?w=500&auto=format&fit=crop'])]
    );
    await dbManager.dbRun(db1, `INSERT INTO menu_items (id, category_id, name, description, base_price_cents, is_available, dietary_tag, image_url, images) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['item_1_3', 'cat_1_2', 'Cheesy Garlic Bread', 'Warm baked garlic bread topped with melted mozzarella', 499, 1, 'VEGETARIAN', 'https://images.unsplash.com/photo-1573145959956-6523bc71417f?w=500&auto=format&fit=crop', JSON.stringify(['https://images.unsplash.com/photo-1573145959956-6523bc71417f?w=500&auto=format&fit=crop'])]
    );

    // Modifier Groups
    await dbManager.dbRun(db1, `INSERT INTO modifier_groups (id, menu_item_id, name, min_selection, max_selection) VALUES (?, ?, ?, ?, ?)`,
      ['modg_1_1', 'item_1_1', 'Choose Pizza Size', 1, 1]
    );
    await dbManager.dbRun(db1, `INSERT INTO modifier_groups (id, menu_item_id, name, min_selection, max_selection) VALUES (?, ?, ?, ?, ?)`,
      ['modg_1_2', 'item_1_2', 'Choose Pizza Size', 1, 1]
    );

    // Modifiers
    await dbManager.dbRun(db1, `INSERT INTO modifiers (id, modifier_group_id, name, price_cents, is_available) VALUES (?, ?, ?, ?, ?)`, ['mod_1_1_1', 'modg_1_1', 'Regular (10")', 0, 1]);
    await dbManager.dbRun(db1, `INSERT INTO modifiers (id, modifier_group_id, name, price_cents, is_available) VALUES (?, ?, ?, ?, ?)`, ['mod_1_1_2', 'modg_1_1', 'Medium (12")', 250, 1]);
    await dbManager.dbRun(db1, `INSERT INTO modifiers (id, modifier_group_id, name, price_cents, is_available) VALUES (?, ?, ?, ?, ?)`, ['mod_1_1_3', 'modg_1_1', 'Large (14")', 500, 1]);

    await dbManager.dbRun(db1, `INSERT INTO modifiers (id, modifier_group_id, name, price_cents, is_available) VALUES (?, ?, ?, ?, ?)`, ['mod_1_2_1', 'modg_1_2', 'Regular (10")', 0, 1]);
    await dbManager.dbRun(db1, `INSERT INTO modifiers (id, modifier_group_id, name, price_cents, is_available) VALUES (?, ?, ?, ?, ?)`, ['mod_1_2_2', 'modg_1_2', 'Medium (12")', 300, 1]);
    await dbManager.dbRun(db1, `INSERT INTO modifiers (id, modifier_group_id, name, price_cents, is_available) VALUES (?, ?, ?, ?, ?)`, ['mod_1_2_3', 'modg_1_2', 'Large (14")', 600, 1]);

    console.log('Seeded Tenant 1.');

    // 5. Seed Tenant 2 (Burger Byte) Database
    console.log('Seeding Tenant 2 (Burger Byte) database...');
    const db2 = await dbManager.getTenantDb('tenant_2');

    // Restaurant branch (Uptown, New York - slightly offset from Downtown)
    await dbManager.dbRun(db2, `INSERT INTO restaurants (id, name, latitude, longitude, address, contact_phone, status) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['rest_2', 'Burger Byte - Uptown NY', 40.7306, -73.9352, '34 Greenpoint Ave, Brooklyn, NY 11222', '718-555-4321', 'OPEN']
    );

    // Categories
    await dbManager.dbRun(db2, `INSERT INTO menu_categories (id, restaurant_id, name, display_order) VALUES (?, ?, ?, ?)`, ['cat_2_1', 'rest_2', 'Gourmet Burgers', 1]);
    await dbManager.dbRun(db2, `INSERT INTO menu_categories (id, restaurant_id, name, display_order) VALUES (?, ?, ?, ?)`, ['cat_2_2', 'rest_2', 'Fries & Drinks', 2]);

    // Menu Items
    await dbManager.dbRun(db2, `INSERT INTO menu_items (id, category_id, name, description, base_price_cents, is_available, dietary_tag, image_url, images) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['item_2_1', 'cat_2_1', 'The Classic Cheeseburger', 'Angus beef patty, cheddar cheese, pickles, and burger sauce', 899, 1, 'NON-VEG', 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=500&auto=format&fit=crop', JSON.stringify(['https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=500&auto=format&fit=crop', 'https://images.unsplash.com/photo-1550547660-d9450f859349?w=500&auto=format&fit=crop'])]
    );
    await dbManager.dbRun(db2, `INSERT INTO menu_items (id, category_id, name, description, base_price_cents, is_available, dietary_tag, image_url, images) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['item_2_2', 'cat_2_1', 'Smoky BBQ Bacon Burger', 'Angus beef, crispy bacon, cheddar, crispy onion strings, BBQ sauce', 1149, 1, 'NON-VEG', 'https://images.unsplash.com/photo-1553979459-d2229ba7433b?w=500&auto=format&fit=crop', JSON.stringify(['https://images.unsplash.com/photo-1553979459-d2229ba7433b?w=500&auto=format&fit=crop', 'https://images.unsplash.com/photo-1586190848861-99aa4a171e90?w=500&auto=format&fit=crop'])]
    );
    await dbManager.dbRun(db2, `INSERT INTO menu_items (id, category_id, name, description, base_price_cents, is_available, dietary_tag, image_url, images) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['item_2_3', 'cat_2_2', 'Salted Waffle Fries', 'Crispy waffle fries lightly salted with fine sea salt', 349, 1, 'VEGETARIAN', 'https://images.unsplash.com/photo-1576107232684-1279f390859f?w=500&auto=format&fit=crop', JSON.stringify(['https://images.unsplash.com/photo-1576107232684-1279f390859f?w=500&auto=format&fit=crop'])]
    );

    // Modifier Groups
    await dbManager.dbRun(db2, `INSERT INTO modifier_groups (id, menu_item_id, name, min_selection, max_selection) VALUES (?, ?, ?, ?, ?)`,
      ['modg_2_1', 'item_2_1', 'Add Toppings', 0, 3]
    );

    // Modifiers
    await dbManager.dbRun(db2, `INSERT INTO modifiers (id, modifier_group_id, name, price_cents, is_available) VALUES (?, ?, ?, ?, ?)`, ['mod_2_1_1', 'modg_2_1', 'Extra Bacon', 150, 1]);
    await dbManager.dbRun(db2, `INSERT INTO modifiers (id, modifier_group_id, name, price_cents, is_available) VALUES (?, ?, ?, ?, ?)`, ['mod_2_1_2', 'modg_2_1', 'Avocado Slice', 100, 1]);
    await dbManager.dbRun(db2, `INSERT INTO modifiers (id, modifier_group_id, name, price_cents, is_available) VALUES (?, ?, ?, ?, ?)`, ['mod_2_1_3', 'modg_2_1', 'Fried Egg', 120, 1]);

    console.log('Seeded Tenant 2.');

    console.log('All databases successfully seeded!');
  } catch (error) {
    console.error('Seeding encountered an error:', error);
  }
}

seed();

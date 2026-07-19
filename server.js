const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const dbManager = require('./db');

const JWT_SECRET = 'saas-secret-key-12345';
const PORT = 3000;

const app = express();
app.use(express.json());

// Virtual Frontend Pages Routing
app.get(['/platform-admin', '/tenant-admin', '/driver', '/storefront'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

// Ensure public/uploads directory exists
const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Multer Storage Configuration
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname) || '.png';
    cb(null, 'dish_photo-' + uniqueSuffix + ext);
  }
});
const upload = multer({ storage: storage });

// Active Driver In-Memory Locations (Simulating Redis Geospatial Index)
// Structure: { [driverId]: { lat, lng, status: 'ONLINE'|'DELIVERING'|'OFFLINE', name } }
const activeDrivers = {
  'usr_driver_1': { lat: 40.7100, lng: -74.0150, status: 'ONLINE', name: 'Dave Fast' },
  'usr_driver_2': { lat: 40.7250, lng: -73.9500, status: 'ONLINE', name: 'Dan Quick' }
};

// Global Store of Active WebSocket Connections
// Structure: { [userId]: wsClient }
const wsClients = {};

// Active dispatch requests tracking (offers sent to drivers waiting for response)
// Structure: { [deliveryId]: { order, restaurant, driverId, timeoutId, rejectList: [] } }
const activeDispatches = {};

// ==========================================
// MIDDLEWARES
// ==========================================

// Authenticate JWT and inject user details into request context
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ error: 'Authentication token required' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = user;
    next();
  });
}

// Tenant Resolution & Isolation Middleware
// Enforces that users cannot access operations of a tenant they don't belong to
async function resolveTenantContext(req, res, next) {
  let requestedTenantId = null;

  // 1. Try resolving tenant from Host header subdomain (e.g. tenant_1.localhost:3000 -> tenant_1)
  const hostHeader = req.headers.host;
  if (hostHeader) {
    const hostname = hostHeader.split(':')[0].toLowerCase(); // Remove port and make lowercase
    const parts = hostname.split('.');
    
    // 1. Localhost subdomains (e.g. tenant_1.localhost)
    if (parts.length === 2 && parts[1] === 'localhost' && parts[0] !== 'www') {
      requestedTenantId = parts[0];
    }
    // 2. Wildcard nip.io subdomains (e.g. tenant_1.16.170.251.215.nip.io)
    else if (hostname.endsWith('.nip.io') && parts.length === 7 && parts[0] !== 'www') {
      requestedTenantId = parts[0];
    }
    // 3. Custom domain subdomains (e.g. tenant_1.yourdomain.com)
    else if (parts.length === 3 && parts[1] !== 'nip' && parts[0] !== 'www') {
      requestedTenantId = parts[0];
    }
  }

  // 2. Fallback to X-Tenant-ID header or query parameter
  if (!requestedTenantId) {
    requestedTenantId = req.headers['x-tenant-id'] || req.query.tenantId;
  }

  if (!requestedTenantId) {
    return res.status(400).json({ error: 'Tenant context (Subdomain, X-Tenant-ID header, or tenantId query param) is required' });
  }

  // 3. Verify tenant exists in platform metadata DB
  try {
    const platformDb = dbManager.getPlatformDb();
    const tenant = await dbManager.dbGet(platformDb, 'SELECT * FROM tenants WHERE id = ?', [requestedTenantId]);
    if (!tenant) {
      return res.status(404).json({ error: `Tenant '${requestedTenantId}' not found on this platform` });
    }
  } catch (err) {
    return res.status(500).json({ error: `Database error verifying tenant: ${err.message}` });
  }

  // 4. Inject tenant database connection into request
  try {
    const tenantDb = await dbManager.getTenantDb(requestedTenantId);
    req.tenantId = requestedTenantId;
    req.tenantDb = tenantDb;
  } catch (err) {
    return res.status(500).json({ error: `Failed to resolve tenant database: ${err.message}` });
  }

  // If user is logged in, perform tenancy validation
  if (req.user) {
    const { role, tenantId: userTenantId } = req.user;

    // Platform Admins can bypass tenant-specific boundaries for support
    if (role === 'PLATFORM_ADMIN') {
      return next();
    }

    // Consumers can browse any tenant store, their user profile has tenant_id = null
    if (role === 'CONSUMER' || role === 'DRIVER') {
      return next();
    }

    // Tenant-specific users (Admins/Staff) must match the requested tenant context exactly
    if (userTenantId !== requestedTenantId) {
      return res.status(403).json({ error: 'Access Denied: You do not belong to this tenant' });
    }
  }

  next();
}

// ==========================================
// REST ENDPOINTS
// ==========================================

// Auth Registration for Consumers
app.post('/api/auth/register', async (req, res) => {
  const { email, password, firstName, lastName, phone, address, tenantId } = req.body;
  if (!email || !password || !firstName || !lastName || !phone || !address || !tenantId) {
    return res.status(400).json({ error: 'All fields (email, password, firstName, lastName, phone, address, tenantId) are required' });
  }

  try {
    const platformDb = dbManager.getPlatformDb();
    
    // Check if user already exists under this tenant partition
    const existingUser = await dbManager.dbGet(platformDb, 'SELECT * FROM users WHERE email = ? AND tenant_id = ?', [email, tenantId]);
    if (existingUser) {
      return res.status(409).json({ error: 'User with this email is already registered for this restaurant partition' });
    }

    const userId = `usr_cons_${Date.now()}`;
    await dbManager.dbRun(
      platformDb,
      `INSERT INTO users (id, tenant_id, email, password_hash, role, first_name, last_name, phone, address, status) 
       VALUES (?, ?, ?, ?, 'CONSUMER', ?, ?, ?, ?, 'ACTIVE')`,
      [userId, tenantId, email, password, firstName, lastName, phone, address]
    );

    // Generate JWT Token automatically for auto-login
    const token = jwt.sign(
      { id: userId, tenantId, role: 'CONSUMER', email },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.status(201).json({
      message: 'Registration successful',
      token,
      user: {
        id: userId,
        email,
        role: 'CONSUMER',
        firstName,
        lastName,
        phone,
        address,
        tenantId
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Driver registration
app.post('/api/auth/register-driver', async (req, res) => {
  const { email, password, firstName, lastName, phone, tenantId } = req.body;
  if (!email || !password || !firstName || !lastName || !phone || !tenantId) {
    return res.status(400).json({ error: 'All fields (email, password, firstName, lastName, phone, tenantId) are required' });
  }

  try {
    const platformDb = dbManager.getPlatformDb();
    
    // Check if driver already exists under this tenant partition
    const existingUser = await dbManager.dbGet(platformDb, 'SELECT * FROM users WHERE email = ? AND tenant_id = ?', [email, tenantId]);
    if (existingUser) {
      return res.status(409).json({ error: 'A driver with this email address is already registered for this restaurant partition' });
    }

    const userId = `usr_drv_${Date.now()}`;
    await dbManager.dbRun(
      platformDb,
      `INSERT INTO users (id, tenant_id, email, password_hash, role, first_name, last_name, phone, address, status) 
       VALUES (?, ?, ?, ?, 'DRIVER', ?, ?, ?, NULL, 'ACTIVE')`,
      [userId, tenantId, email, password, firstName, lastName, phone]
    );

    // Auto-login: Generate token
    const token = jwt.sign(
      { id: userId, tenantId, role: 'DRIVER', email, firstName, lastName },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.status(201).json({
      message: 'Driver registered successfully',
      token,
      user: {
        id: userId,
        email,
        role: 'DRIVER',
        firstName,
        lastName,
        phone,
        tenantId
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Auth Login Simulation
app.post('/api/auth/login', async (req, res) => {
  const { email, password, tenantId } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email/phone and password are required' });
  }

  try {
    const platformDb = dbManager.getPlatformDb();
    
    // First, look for a user matching the email or phone under the specified tenant partition
    let user = null;
    if (tenantId) {
      user = await dbManager.dbGet(
        platformDb, 
        'SELECT * FROM users WHERE (email = ? OR phone = ?) AND tenant_id = ?', 
        [email, email, tenantId]
      );
    }
    
    // Fallback: search for a global platform admin user where tenant_id is NULL
    if (!user) {
      user = await dbManager.dbGet(
        platformDb, 
        "SELECT * FROM users WHERE (email = ? OR phone = ?) AND tenant_id IS NULL AND role = 'PLATFORM_ADMIN'", 
        [email, email]
      );
    }

    if (!user || user.password_hash !== password) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Generate JWT Token
    const token = jwt.sign(
      { id: user.id, tenantId: user.tenant_id, role: user.role, email: user.email, firstName: user.first_name, lastName: user.last_name },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        firstName: user.first_name,
        lastName: user.last_name,
        tenantId: user.tenant_id
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- PLATFORM ADMIN ENDPOINTS ---

// List all tenants
app.get('/api/admin/tenants', authenticateToken, async (req, res) => {
  if (req.user.role !== 'PLATFORM_ADMIN') {
    return res.status(403).json({ error: 'Require Platform Admin role' });
  }

  try {
    const platformDb = dbManager.getPlatformDb();
    const tenants = await dbManager.dbAll(platformDb, 'SELECT * FROM tenants');
    
    // Add operational counts (number of orders) dynamically from each tenant DB
    const results = [];
    for (let tenant of tenants) {
      try {
        const tenantDb = await dbManager.getTenantDb(tenant.id);
        const orderCount = await dbManager.dbGet(tenantDb, 'SELECT COUNT(*) as count FROM orders');
        const restaurant = await dbManager.dbGet(tenantDb, 'SELECT name FROM restaurants LIMIT 1');
        results.push({
          ...tenant,
          ordersCount: orderCount.count,
          restaurantName: restaurant ? restaurant.name : 'No Branch Setup'
        });
      } catch (err) {
        results.push({ ...tenant, ordersCount: 0, restaurantName: 'Error loading' });
      }
    }

    res.json(results);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Onboard new tenant (Dynamic database provisioning)
app.post('/api/admin/tenants', authenticateToken, async (req, res) => {
  if (req.user.role !== 'PLATFORM_ADMIN') {
    return res.status(403).json({ error: 'Require Platform Admin role' });
  }

  const { id, businessName, domain, subscriptionTier, email, phone } = req.body;
  if (!id || !businessName || !domain || !subscriptionTier || !email || !phone) {
    return res.status(400).json({ error: 'All fields (id, businessName, domain, subscriptionTier, email, phone) are required' });
  }

  try {
    const platformDb = dbManager.getPlatformDb();
    
    // Create Tenant in platform metadata db
    await dbManager.dbRun(
      platformDb,
      `INSERT INTO tenants (id, business_name, domain, email, phone, status, stripe_account_id, subscription_tier) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, businessName, domain, email, phone, 'ACTIVE', `acct_stripe_${id}`, subscriptionTier]
    );

    // Create Tenant Admin User
    const adminId = `usr_${id}_admin`;
    await dbManager.dbRun(
      platformDb,
      `INSERT INTO users (id, tenant_id, email, password_hash, role, first_name, last_name, phone) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [adminId, id, email, 'password123', 'TENANT_ADMIN', 'Tenant', 'Admin', phone]
    );

    // Call dynamic database loader which initiates the database file and executes tenant schema tables automatically
    const tenantDb = await dbManager.getTenantDb(id);

    // Seed dummy restaurant branch details for the tenant database
    await dbManager.dbRun(
      tenantDb,
      `INSERT INTO restaurants (id, name, latitude, longitude, address, status) VALUES (?, ?, ?, ?, ?, ?)`,
      [`rest_${id}`, `${businessName} Express`, 40.7128 + (Math.random() - 0.5) * 0.05, -74.0060 + (Math.random() - 0.5) * 0.05, `100 Main St, ${businessName} District`, 'OPEN']
    );

    res.status(201).json({
      message: `Tenant ${businessName} successfully provisioned!`,
      tenantId: id,
      adminEmail: email,
      adminPassword: 'password123'
    });
  } catch (error) {
    res.status(500).json({ error: `Provisioning failed: ${error.message}` });
  }
});

// Edit existing tenant details (Platform Admin only)
app.put('/api/admin/tenants/:id', authenticateToken, async (req, res) => {
  if (req.user.role !== 'PLATFORM_ADMIN') {
    return res.status(403).json({ error: 'Require Platform Admin role' });
  }

  const { id } = req.params;
  const { businessName, domain, subscriptionTier, status, email, phone } = req.body;
  if (!businessName || !domain || !subscriptionTier || !status || !email || !phone) {
    return res.status(400).json({ error: 'All fields (businessName, domain, subscriptionTier, status, email, phone) are required' });
  }

  try {
    const platformDb = dbManager.getPlatformDb();
    
    // Check if tenant exists
    const tenant = await dbManager.dbGet(platformDb, 'SELECT * FROM tenants WHERE id = ?', [id]);
    if (!tenant) {
      return res.status(404).json({ error: `Tenant with ID '${id}' not found` });
    }

    // Update Tenant Details
    await dbManager.dbRun(
      platformDb,
      `UPDATE tenants SET business_name = ?, domain = ?, subscription_tier = ?, status = ?, email = ?, phone = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [businessName, domain, subscriptionTier, status, email, phone, id]
    );

    // Update Tenant Admin User Details
    await dbManager.dbRun(
      platformDb,
      `UPDATE users SET email = ?, phone = ? WHERE tenant_id = ? AND role = 'TENANT_ADMIN'`,
      [email, phone, id]
    );

    res.json({ message: `Tenant details for '${id}' updated successfully.` });
  } catch (error) {
    res.status(500).json({ error: `Failed to update tenant: ${error.message}` });
  }
});


// --- CONSUMER CLIENT ENDPOINTS ---

// Public storefront listing (Cross-Tenant discovery)
app.get('/api/storefront/restaurants', async (req, res) => {
  try {
    const platformDb = dbManager.getPlatformDb();
    const tenants = await dbManager.dbAll(platformDb, "SELECT * FROM tenants WHERE status = 'ACTIVE'");

    const storefronts = [];
    for (const tenant of tenants) {
      try {
        const tenantDb = await dbManager.getTenantDb(tenant.id);
        const rest = await dbManager.dbGet(tenantDb, "SELECT * FROM restaurants WHERE status = 'OPEN'");
        if (rest) {
          storefronts.push({
            tenantId: tenant.id,
            businessName: tenant.business_name,
            restaurantId: rest.id,
            name: rest.name,
            address: rest.address,
            latitude: rest.latitude,
            longitude: rest.longitude,
            deliveryEnabled: rest.delivery_enabled,
            pickupEnabled: rest.pickup_enabled
          });
        }
      } catch (e) {
        console.error(`Error loading store details for tenant ${tenant.id}:`, e);
      }
    }
    res.json(storefronts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch tenant menu
app.get('/api/storefront/restaurants/:tenant_id/menu', async (req, res) => {
  const { tenant_id } = req.params;
  try {
    const tenantDb = await dbManager.getTenantDb(tenant_id);
    
    // Fetch categories
    const categories = await dbManager.dbAll(tenantDb, 'SELECT * FROM menu_categories ORDER BY display_order ASC');
    
    // Assemble full hierarchical menu tree
    const menuTree = [];
    for (const cat of categories) {
      const items = await dbManager.dbAll(tenantDb, 'SELECT * FROM menu_items WHERE category_id = ? AND is_available = 1', [cat.id]);
      
      const itemsWithModifiers = [];
      for (const item of items) {
        const modGroups = await dbManager.dbAll(tenantDb, 'SELECT * FROM modifier_groups WHERE menu_item_id = ?', [item.id]);
        
        const groupsWithMods = [];
        for (const group of modGroups) {
          const modifiers = await dbManager.dbAll(tenantDb, 'SELECT * FROM modifiers WHERE modifier_group_id = ? AND is_available = 1', [group.id]);
          groupsWithMods.push({ ...group, modifiers });
        }
        
        itemsWithModifiers.push({ ...item, modifierGroups: groupsWithMods });
      }
      
      menuTree.push({ ...cat, items: itemsWithModifiers });
    }

    res.json(menuTree);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Checkout Order
app.post('/api/storefront/orders', authenticateToken, resolveTenantContext, async (req, res) => {
  const { restaurantId, items, deliveryAddress, deliveryLat, deliveryLng, paymentMethod, fulfillmentType } = req.body;
  if (!restaurantId || !items || !items.length || !deliveryAddress || !deliveryLat || !deliveryLng) {
    return res.status(400).json({ error: 'Missing required checkout fields' });
  }

  try {
    const db = req.tenantDb;
    
    // Calculate values (Simulating secure server side calculations)
    let subtotalCents = 0;
    
    // Loop through selected items and verify prices from the database
    for (const clientItem of items) {
      const dbItem = await dbManager.dbGet(db, 'SELECT base_price_cents, discount_price_cents FROM menu_items WHERE id = ?', [clientItem.menuItemId]);
      if (!dbItem) return res.status(400).json({ error: `Item ${clientItem.menuItemId} not found` });
      
      let itemCost = (dbItem.discount_price_cents !== null && dbItem.discount_price_cents !== undefined) ? dbItem.discount_price_cents : dbItem.base_price_cents;
      
      // Calculate selected modifier costs
      if (clientItem.selectedModifiers) {
        for (const modId of clientItem.selectedModifiers) {
          const dbMod = await dbManager.dbGet(db, 'SELECT price_cents FROM modifiers WHERE id = ?', [modId]);
          if (dbMod) itemCost += dbMod.price_cents;
        }
      }
      
      subtotalCents += itemCost * clientItem.quantity;
    }

    const type = (fulfillmentType && ['DELIVERY', 'PICKUP'].includes(fulfillmentType.toUpperCase())) ? fulfillmentType.toUpperCase() : 'DELIVERY';
    const deliveryFeeCents = type === 'PICKUP' ? 0 : 350; // Pickup has 0 delivery fee
    const pickupCode = type === 'PICKUP' ? Math.floor(100000 + Math.random() * 900000).toString() : null;
    const taxCents = Math.round(subtotalCents * 0.08); // Mock 8% Tax
    
    // Calculate Commission Fee (e.g. 12% model split)
    const platformCommissionCents = Math.round(subtotalCents * 0.12);
    const totalCents = subtotalCents + deliveryFeeCents + taxCents;

    const orderId = `ord_${Date.now()}`;
    const customerId = req.user.id;

    // Resolve payment status based on chosen method
    const payMethod = (paymentMethod && ['CARD', 'UPI', 'COD'].includes(paymentMethod.toUpperCase())) ? paymentMethod.toUpperCase() : 'CARD';
    const payStatus = payMethod === 'COD' ? 'PENDING' : 'PAID';

    // Create Order Record in tenant database
    await dbManager.dbRun(
      db,
      `INSERT INTO orders (id, customer_id, restaurant_id, status, subtotal_cents, delivery_fee_cents, tax_cents, platform_commission_cents, total_cents, payment_status, payment_method, delivery_address, delivery_lat, delivery_lng, fulfillment_type, pickup_code) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [orderId, customerId, restaurantId, 'PLACED', subtotalCents, deliveryFeeCents, taxCents, platformCommissionCents, totalCents, payStatus, payMethod, deliveryAddress, deliveryLat, deliveryLng, type, pickupCode]
    );

    // Save Line items & modifier entries
    for (const clientItem of items) {
      const itemId = `ord_item_${Math.random().toString(36).substr(2, 9)}`;
      
      // Get base item price
      const dbItem = await dbManager.dbGet(db, 'SELECT base_price_cents, discount_price_cents FROM menu_items WHERE id = ?', [clientItem.menuItemId]);
      const finalPrice = (dbItem.discount_price_cents !== null && dbItem.discount_price_cents !== undefined) ? dbItem.discount_price_cents : dbItem.base_price_cents;
      
      await dbManager.dbRun(
        db,
        `INSERT INTO order_items (id, order_id, menu_item_id, quantity, price_cents) VALUES (?, ?, ?, ?, ?)`,
        [itemId, orderId, clientItem.menuItemId, clientItem.quantity, finalPrice]
      );

      if (clientItem.selectedModifiers) {
        for (const modId of clientItem.selectedModifiers) {
          const dbMod = await dbManager.dbGet(db, 'SELECT price_cents FROM modifiers WHERE id = ?', [modId]);
          const itemModId = `ord_mod_${Math.random().toString(36).substr(2, 9)}`;
          await dbManager.dbRun(
            db,
            `INSERT INTO order_item_modifiers (id, order_item_id, modifier_id, price_cents) VALUES (?, ?, ?, ?)`
            ,[itemModId, itemId, modId, dbMod.price_cents]
          );
        }
      }
    }

    // Broadcast new order to Tenant Admin WebSocket
    const payload = {
      event: 'order_update',
      data: {
        orderId,
        tenantId: req.tenantId,
        status: 'PLACED',
        totalCents,
        subtotalCents,
        items
      }
    };
    broadcastToTenantAdmins(req.tenantId, payload);

    res.status(201).json({
      message: 'Order checked out and paid successfully.',
      orderId,
      subtotalCents,
      deliveryFeeCents,
      taxCents,
      platformCommissionCents,
      totalCents,
      pickupCode,
      splitDetails: {
        platformEarnings: platformCommissionCents + deliveryFeeCents,
        tenantEarnings: totalCents - (platformCommissionCents + deliveryFeeCents)
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch consumer order history (cross-tenant aggregation)
app.get('/api/storefront/orders/history', authenticateToken, async (req, res) => {
  const customerId = req.user.id;
  try {
    const platformDb = dbManager.getPlatformDb();
    const tenants = await dbManager.dbAll(platformDb, 'SELECT * FROM tenants');
    
    const allOrders = [];
    for (const tenant of tenants) {
      try {
        const tenantDb = await dbManager.getTenantDb(tenant.id);
        
        // Fetch orders for this customer in this tenant DB
        const orders = await dbManager.dbAll(tenantDb, 'SELECT * FROM orders WHERE customer_id = ? ORDER BY created_at DESC', [customerId]);
        
        for (let o of orders) {
          // Fetch items details
          const items = await dbManager.dbAll(tenantDb, `
            SELECT oi.*, mi.name as menu_item_name 
            FROM order_items oi
            JOIN menu_items mi ON oi.menu_item_id = mi.id
            WHERE oi.order_id = ?
          `, [o.id]);
          
          allOrders.push({
            ...o,
            tenantId: tenant.id,
            restaurantName: tenant.business_name,
            items
          });
        }
      } catch (err) {
        console.error(`Error reading order history for tenant ${tenant.id}:`, err);
      }
    }
    
    // Sort all aggregated orders by created_at descending
    allOrders.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    res.json(allOrders);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch active order tracking details
app.get('/api/storefront/orders/:orderId/track', authenticateToken, resolveTenantContext, async (req, res) => {
  const { orderId } = req.params;
  try {
    const db = req.tenantDb;
    const order = await dbManager.dbGet(db, 'SELECT * FROM orders WHERE id = ?', [orderId]);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    // Fetch restaurant coordinates
    const restaurant = await dbManager.dbGet(db, 'SELECT * FROM restaurants WHERE id = ?', [order.restaurant_id]);
    
    // Fetch active delivery driver location coordinates if assigned
    const delivery = await dbManager.dbGet(db, 'SELECT * FROM deliveries WHERE order_id = ?', [orderId]);
    
    let driverName = null;
    let driverLat = null;
    let driverLng = null;

    if (delivery && delivery.driver_id) {
      // Find driver name and latest coordinates from platform users table
      const platformDb = dbManager.getPlatformDb();
      const driverUser = await dbManager.dbGet(platformDb, 'SELECT first_name, last_name FROM users WHERE id = ?', [delivery.driver_id]);
      if (driverUser) {
        driverName = `${driverUser.first_name} ${driverUser.last_name}`;
      }
      
      driverLat = delivery.driver_lat;
      driverLng = delivery.driver_lng;
    }

    res.json({
      orderId: order.id,
      status: order.status,
      restaurantName: restaurant ? restaurant.name : 'Unknown Branch',
      restLat: restaurant ? restaurant.latitude : 40.7128,
      restLng: restaurant ? restaurant.longitude : -74.0060,
      custLat: order.delivery_lat,
      custLng: order.delivery_lng,
      driverLat,
      driverLng,
      driverName,
      fulfillmentType: order.fulfillment_type,
      pickupCode: order.pickup_code
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// --- TENANT MANAGEMENT ENDPOINTS ---

// Read Tenant orders
app.get('/api/tenant/orders', authenticateToken, resolveTenantContext, async (req, res) => {
  try {
    const db = req.tenantDb;
    const orders = await dbManager.dbAll(db, 'SELECT * FROM orders ORDER BY created_at DESC');
    
    // Retrieve associated line items and metadata
    const populatedOrders = [];
    for (let o of orders) {
      const items = await dbManager.dbAll(db, `
        SELECT oi.*, mi.name as menu_item_name 
        FROM order_items oi
        JOIN menu_items mi ON oi.menu_item_id = mi.id
        WHERE oi.order_id = ?
      `, [o.id]);
      
      const populatedItems = [];
      for (let item of items) {
        const modifiers = await dbManager.dbAll(db, `
          SELECT oim.*, m.name as modifier_name 
          FROM order_item_modifiers oim
          JOIN modifiers m ON oim.modifier_id = m.id
          WHERE oim.order_item_id = ?
        `, [item.id]);
        populatedItems.push({ ...item, modifiers });
      }
      
      // Fetch delivery details if assigned
      const delivery = await dbManager.dbGet(db, 'SELECT * FROM deliveries WHERE order_id = ?', [o.id]);
      populatedOrders.push({ ...o, items: populatedItems, delivery });
    }

    res.json(populatedOrders);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update Tenant Menu Item availability
app.patch('/api/tenant/menu/items/:id', authenticateToken, resolveTenantContext, async (req, res) => {
  const { id } = req.params;
  const { is_available } = req.body;
  if (is_available === undefined) return res.status(400).json({ error: 'is_available state required' });

  try {
    await dbManager.dbRun(req.tenantDb, 'UPDATE menu_items SET is_available = ? WHERE id = ?', [is_available ? 1 : 0, id]);
    res.json({ message: 'Menu item availability status updated successfully.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get Tenant Menu Categories (For drop-down selection)
app.get('/api/tenant/menu/categories', authenticateToken, resolveTenantContext, async (req, res) => {
  try {
    const categories = await dbManager.dbAll(req.tenantDb, 'SELECT * FROM menu_categories');
    res.json(categories);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create new Tenant Menu Category
app.post('/api/tenant/menu/categories', authenticateToken, resolveTenantContext, async (req, res) => {
  const { name, displayOrder } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'Category name is required' });
  }

  const categoryId = `cat_${Date.now()}`;
  const orderVal = (displayOrder !== undefined && displayOrder !== null && displayOrder !== '') ? parseInt(displayOrder, 10) : 0;

  try {
    const restaurant = await dbManager.dbGet(req.tenantDb, 'SELECT id FROM restaurants LIMIT 1');
    const restaurantId = restaurant ? restaurant.id : `rest_${req.tenantId}`;

    await dbManager.dbRun(
      req.tenantDb,
      'INSERT INTO menu_categories (id, restaurant_id, name, display_order) VALUES (?, ?, ?, ?)',
      [categoryId, restaurantId, name, orderVal]
    );
    res.status(201).json({ message: 'Menu category created successfully', categoryId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// REST Endpoint to upload dish photos
app.post('/api/tenant/menu/items/upload', authenticateToken, resolveTenantContext, upload.single('photo'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No photo file provided' });
  }
  // Return the public URL path
  const imageUrl = `/uploads/${req.file.filename}`;
  res.json({ message: 'Photo uploaded successfully', imageUrl });
});

// Create new Tenant Menu Item (Dish)
app.post('/api/tenant/menu/items', authenticateToken, resolveTenantContext, async (req, res) => {
  const { categoryId, name, description, basePriceCents, discountPriceCents, dietaryTag, isAvailable, images } = req.body;
  if (!categoryId || !name || basePriceCents === undefined) {
    return res.status(400).json({ error: 'categoryId, name, and basePriceCents are required' });
  }

  const itemId = `item_${Date.now()}`;
  const discCents = (discountPriceCents !== undefined && discountPriceCents !== null && discountPriceCents !== '') ? parseInt(discountPriceCents, 10) : null;

  const imgList = (images && Array.isArray(images)) ? images : [];
  const primaryImg = imgList.length > 0 ? imgList[0] : null;
  const imagesJson = imgList.length > 0 ? JSON.stringify(imgList) : null;

  try {
    await dbManager.dbRun(
      req.tenantDb,
      `INSERT INTO menu_items (id, category_id, name, description, base_price_cents, discount_price_cents, is_available, dietary_tag, image_url, images) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [itemId, categoryId, name, description, parseInt(basePriceCents, 10), discCents, isAvailable ? 1 : 0, dietaryTag, primaryImg, imagesJson]
    );
    res.status(201).json({ message: 'Menu item created successfully', itemId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update Tenant Menu Item (Dish)
app.put('/api/tenant/menu/items/:id', authenticateToken, resolveTenantContext, async (req, res) => {
  const { id } = req.params;
  const { categoryId, name, description, basePriceCents, discountPriceCents, dietaryTag, isAvailable, images } = req.body;
  if (!categoryId || !name || basePriceCents === undefined) {
    return res.status(400).json({ error: 'categoryId, name, and basePriceCents are required' });
  }

  const discCents = (discountPriceCents !== undefined && discountPriceCents !== null && discountPriceCents !== '') ? parseInt(discountPriceCents, 10) : null;

  const imgList = (images && Array.isArray(images)) ? images : [];
  const primaryImg = imgList.length > 0 ? imgList[0] : null;
  const imagesJson = imgList.length > 0 ? JSON.stringify(imgList) : null;

  try {
    await dbManager.dbRun(
      req.tenantDb,
      `UPDATE menu_items 
       SET category_id = ?, name = ?, description = ?, base_price_cents = ?, discount_price_cents = ?, is_available = ?, dietary_tag = ?, image_url = ?, images = ? 
       WHERE id = ?`,
      [categoryId, name, description, parseInt(basePriceCents, 10), discCents, isAvailable ? 1 : 0, dietaryTag, primaryImg, imagesJson, id]
    );
    res.json({ message: 'Menu item updated successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// List all registered consumers under this tenant (Tenant Admin view)
app.get('/api/tenant/consumers', authenticateToken, async (req, res) => {
  if (req.user.role !== 'TENANT_ADMIN') {
    return res.status(403).json({ error: 'Require Tenant Admin role' });
  }
  try {
    const platformDb = dbManager.getPlatformDb();
    const consumers = await dbManager.dbAll(
      platformDb, 
      'SELECT id, email, first_name, last_name, phone, created_at FROM users WHERE role = "CONSUMER" AND tenant_id = ? ORDER BY created_at DESC',
      [req.user.tenantId]
    );
    res.json(consumers);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete Tenant Menu Item
app.delete('/api/tenant/menu/items/:id', authenticateToken, resolveTenantContext, async (req, res) => {
  const { id } = req.params;
  try {
    await dbManager.dbRun(req.tenantDb, 'DELETE FROM menu_items WHERE id = ?', [id]);
    res.json({ message: 'Menu item deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch storefront settings configuration
app.get('/api/tenant/settings', authenticateToken, resolveTenantContext, async (req, res) => {
  try {
    const db = req.tenantDb;
    const rest = await dbManager.dbGet(db, 'SELECT delivery_enabled, pickup_enabled FROM restaurants LIMIT 1');
    res.json(rest || { delivery_enabled: 1, pickup_enabled: 1 });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Save storefront settings configuration
app.post('/api/tenant/settings', authenticateToken, resolveTenantContext, async (req, res) => {
  const { deliveryEnabled, pickupEnabled } = req.body;
  try {
    const db = req.tenantDb;
    await dbManager.dbRun(
      db, 
      'UPDATE restaurants SET delivery_enabled = ?, pickup_enabled = ?', 
      [deliveryEnabled ? 1 : 0, pickupEnabled ? 1 : 0]
    );
    res.json({ message: 'Settings saved successfully', deliveryEnabled, pickupEnabled });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Order State Machine Transitions (FSM Guard Rules)
app.post('/api/tenant/orders/:id/transition', authenticateToken, resolveTenantContext, async (req, res) => {
  const { id } = req.params;
  const { targetStatus, pickupCode } = req.body;
  if (!targetStatus) return res.status(400).json({ error: 'targetStatus field required' });

  const VALID_TRANSITIONS = {
    'PLACED': ['ACCEPTED', 'CANCELLED'],
    'ACCEPTED': ['PREPARING', 'CANCELLED'],
    'PREPARING': ['READY', 'CANCELLED'],
    'READY': ['DISPATCHED', 'DELIVERED'],
    'DISPATCHED': ['DELIVERED']
  };

  try {
    const db = req.tenantDb;
    const order = await dbManager.dbGet(db, 'SELECT * FROM orders WHERE id = ?', [id]);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const currentStatus = order.status;
    const allowed = VALID_TRANSITIONS[currentStatus];

    if (!allowed || !allowed.includes(targetStatus)) {
      return res.status(400).json({
        error: `Illegal state transition attempt. Cannot transition from '${currentStatus}' to '${targetStatus}'`
      });
    }

    // Secure Pass Code Verification check for Self-Pickup fulfillment method
    if (targetStatus === 'DELIVERED' && order.fulfillment_type === 'PICKUP') {
      if (!pickupCode || pickupCode.trim() !== order.pickup_code) {
        return res.status(400).json({ error: 'Invalid or missing pickup verification pass code.' });
      }
    }

    // Update Status
    await dbManager.dbRun(db, 'UPDATE orders SET status = ? WHERE id = ?', [targetStatus, id]);

    // Handle background actions for transitions
    if ((targetStatus === 'ACCEPTED' || targetStatus === 'PREPARING') && order.fulfillment_type !== 'PICKUP') {
      // Trigger driver dispatch routing algorithm async
      triggerDispatchLoop(req.tenantId, order);
    }

    // Sync state with deliveries table and driver status memory
    if (targetStatus === 'DISPATCHED') {
      await dbManager.dbRun(db, "UPDATE deliveries SET status = 'PICKED_UP', picked_up_at = CURRENT_TIMESTAMP WHERE order_id = ?", [id]);
    } else if (targetStatus === 'DELIVERED') {
      const delivery = await dbManager.dbGet(db, 'SELECT driver_id FROM deliveries WHERE order_id = ?', [id]);
      if (delivery && delivery.driver_id) {
        // Set driver status back to ONLINE to receive future offers
        if (activeDrivers[delivery.driver_id]) {
          activeDrivers[delivery.driver_id].status = 'ONLINE';
        }
        await dbManager.dbRun(db, "UPDATE deliveries SET status = 'DELIVERED', delivered_at = CURRENT_TIMESTAMP WHERE order_id = ?", [id]);
      }
    }

    // Broadcast update over WebSockets
    const payload = {
      event: 'order_update',
      data: { orderId: id, tenantId: req.tenantId, status: targetStatus }
    };
    
    // Notify customer
    sendToUser(order.customer_id, payload);
    // Notify tenant admins
    broadcastToTenantAdmins(req.tenantId, payload);

    res.json({ message: `Order status advanced to ${targetStatus}`, status: targetStatus });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// --- DRIVER ENDPOINTS ---

// View delivery offers / Active assignments
app.get('/api/driver/deliveries', authenticateToken, async (req, res) => {
  if (req.user.role !== 'DRIVER') return res.status(403).json({ error: 'Require DRIVER role' });

  const driverId = req.user.id;
  try {
    // Cross-tenant lookup: We check deliveries across all active tenants databases
    const platformDb = dbManager.getPlatformDb();
    const tenants = await dbManager.dbAll(platformDb, "SELECT id FROM tenants WHERE status = 'ACTIVE'");
    
    const assignedDeliveries = [];
    for (const t of tenants) {
      try {
        const db = await dbManager.getTenantDb(t.id);
        const deliveries = await dbManager.dbAll(db, `
          SELECT d.*, o.delivery_address, o.delivery_lat, o.delivery_lng, o.total_cents, o.status as order_status, r.name as restaurant_name, r.latitude as rest_lat, r.longitude as rest_lng
          FROM deliveries d
          JOIN orders o ON d.order_id = o.id
          JOIN restaurants r ON o.restaurant_id = r.id
          WHERE d.driver_id = ?
        `, [driverId]);
        
        deliveries.forEach(del => {
          assignedDeliveries.push({ ...del, tenantId: t.id });
        });
      } catch (e) {
        console.error(`Error querying deliveries in tenant DB ${t.id}:`, e);
      }
    }
    
    res.json(assignedDeliveries);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Driver responds to dispatch assignment
app.post('/api/driver/deliveries/:tenant_id/:order_id/respond', authenticateToken, async (req, res) => {
  if (req.user.role !== 'DRIVER') return res.status(403).json({ error: 'Require DRIVER role' });
  
  const { tenant_id, order_id } = req.params;
  const { action } = req.body; // 'ACCEPT' or 'REJECT'
  const driverId = req.user.id;

  const dispatchKey = `${tenant_id}:${order_id}`;
  const dispatch = activeDispatches[dispatchKey];

  if (!dispatch || dispatch.driverId !== driverId) {
    return res.status(400).json({ error: 'No active delivery offer exists for this driver' });
  }

  // Clear timeout to avoid next-driver escalation
  clearTimeout(dispatch.timeoutId);

  try {
    const db = await dbManager.getTenantDb(tenant_id);

    if (action === 'ACCEPT') {
      // 1. Mark driver status as DELIVERING (occupied)
      if (activeDrivers[driverId]) activeDrivers[driverId].status = 'DELIVERING';

      // 2. Insert or update delivery entry in Tenant Database (defensive check)
      const delId = `del_${Date.now()}`;
      const existingDelivery = await dbManager.dbGet(db, 'SELECT * FROM deliveries WHERE order_id = ?', [order_id]);
      if (existingDelivery) {
        await dbManager.dbRun(db, `
          UPDATE deliveries 
          SET driver_id = ?, status = 'ACCEPTED', assigned_at = CURRENT_TIMESTAMP 
          WHERE order_id = ?
        `, [driverId, order_id]);
      } else {
        await dbManager.dbRun(db, `
          INSERT INTO deliveries (id, order_id, driver_id, status, assigned_at) 
          VALUES (?, ?, ?, 'ACCEPTED', CURRENT_TIMESTAMP)
        `, [delId, order_id, driverId]);
      }

      delete activeDispatches[dispatchKey];

      // Broadcast changes
      const payload = {
        event: 'delivery_update',
        data: { orderId: order_id, tenantId: tenant_id, driverId, status: 'ACCEPTED', driverName: activeDrivers[driverId].name }
      };
      
      // Notify customer
      sendToUser(dispatch.order.customer_id, payload);
      // Notify tenant admins
      broadcastToTenantAdmins(tenant_id, payload);

      res.json({ message: 'Delivery offer accepted successfully', deliveryStatus: 'ACCEPTED' });
    } else {
      // Driver rejected
      dispatch.rejectList.push(driverId);
      delete activeDispatches[dispatchKey];
      
      // Find next driver in proximity queue
      triggerDispatchLoop(tenant_id, dispatch.order, dispatch.rejectList);
      res.json({ message: 'Delivery offer rejected. Escallating to next driver.' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// ==========================================
// DISPATCH ENGINE (Proximity Algorithm)
// ==========================================

async function triggerDispatchLoop(tenantId, order, rejectList = []) {
  const dispatchKey = `${tenantId}:${order.id}`;
  if (activeDispatches[dispatchKey]) return; // Matchmaking process already running

  try {
    const db = await dbManager.getTenantDb(tenantId);
    const rest = await dbManager.dbGet(db, 'SELECT * FROM restaurants WHERE id = ?', [order.restaurant_id]);
    
    // Step 1: Find available online drivers (no distance/proximity checks, must match tenantId partition)
    const candidates = [];
    for (const [id, driver] of Object.entries(activeDrivers)) {
      if (driver.status === 'ONLINE' && driver.tenantId === tenantId && !rejectList.includes(id)) {
        candidates.push({ id, ...driver });
      }
    }

    if (candidates.length === 0) {
      console.log(`No available drivers for order ${order.id}. Will retry in 10s...`);
      setTimeout(() => triggerDispatchLoop(tenantId, order, rejectList), 10000);
      return;
    }

    // Step 2: Assign offer to the first available online driver
    const selectedDriver = candidates[0];
    console.log(`Offering delivery for order ${order.id} to driver ${selectedDriver.name}`);

    // Track active offer context
    const timeoutId = setTimeout(() => {
      console.log(`Offer for order ${order.id} timed out. Escalating...`);
      rejectList.push(selectedDriver.id);
      delete activeDispatches[dispatchKey];
      triggerDispatchLoop(tenantId, order, rejectList);
    }, 30000); // 30 second acceptance threshold

    activeDispatches[dispatchKey] = {
      order,
      restaurant: rest,
      driverId: selectedDriver.id,
      timeoutId,
      rejectList
    };

    // Send push notification via WS to the driver
    sendToUser(selectedDriver.id, {
      event: 'delivery_offer',
      data: {
        tenantId,
        orderId: order.id,
        restaurantName: rest.name,
        restaurantAddress: rest.address,
        restaurantLat: rest.latitude,
        restaurantLng: rest.longitude,
        deliveryAddress: order.delivery_address,
        deliveryLat: order.delivery_lat,
        deliveryLng: order.delivery_lng,
        payoutAmountCents: 300 // Flat dispatch compensation ($3.00)
      }
    });

  } catch (error) {
    console.error('Dispatch loop exception:', error);
  }
}


// ==========================================
// WEBSOCKET BROADCASTER
// ==========================================

function sendToUser(userId, payload) {
  const ws = wsClients[userId];
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

async function broadcastToTenantAdmins(tenantId, payload) {
  try {
    const platformDb = dbManager.getPlatformDb();
    // Get all tenant admins matching this tenant ID
    const admins = await dbManager.dbAll(platformDb, 'SELECT id FROM users WHERE tenant_id = ? AND role = "TENANT_ADMIN"', [tenantId]);
    admins.forEach(admin => {
      sendToUser(admin.id, payload);
    });
  } catch (e) {
    console.error('WebSocket admin broadcast failed:', e);
  }
}


// ==========================================
// HTTP SERVER & WEBSOCKET SETUP
// ==========================================

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  let authenticatedUser = null;

  ws.on('message', async (message) => {
    try {
      const payload = JSON.parse(message);
      
      // 1. Handle Authentication connection setup
      if (payload.action === 'authenticate') {
        const token = payload.token;
        jwt.verify(token, JWT_SECRET, (err, user) => {
          if (err) {
            ws.send(JSON.stringify({ event: 'auth_error', message: 'WS authentication token rejected' }));
            return;
          }
          authenticatedUser = user;
          wsClients[user.id] = ws;
          console.log(`User ${user.email} successfully linked to WebSocket session.`);
          ws.send(JSON.stringify({ event: 'authenticated', data: { userId: user.id, role: user.role } }));
          
          // Send initial driver coordinate update if they are logged in as a driver
          if (user.role === 'DRIVER' && activeDrivers[user.id]) {
            ws.send(JSON.stringify({
              event: 'location_sync',
              data: { lat: activeDrivers[user.id].lat, lng: activeDrivers[user.id].lng, status: activeDrivers[user.id].status }
            }));
          }
        });
      }

      // 2. Handle Live Driver GPS Coordinates updates
      if (payload.action === 'update_location') {
        if (!authenticatedUser || authenticatedUser.role !== 'DRIVER') {
          return ws.send(JSON.stringify({ event: 'error', message: 'Unauthorized driver action' }));
        }

        const driverId = authenticatedUser.id;
        const { lat, lng, status } = payload.data;
        const name = authenticatedUser.firstName ? `${authenticatedUser.firstName} ${authenticatedUser.lastName || ''}`.trim() : authenticatedUser.email;

        // Save position in-memory (including tenant partitioning details)
        if (activeDrivers[driverId]) {
          activeDrivers[driverId].lat = lat;
          activeDrivers[driverId].lng = lng;
          if (status) activeDrivers[driverId].status = status;
          activeDrivers[driverId].tenantId = authenticatedUser.tenantId;
        } else {
          activeDrivers[driverId] = { lat, lng, status: status || 'ONLINE', name: name, tenantId: authenticatedUser.tenantId };
        }

        // Broadast updated coordinates to consumers tracking active deliveries assigned to this driver
        const platformDb = dbManager.getPlatformDb();
        const tenants = await dbManager.dbAll(platformDb, "SELECT id FROM tenants WHERE status = 'ACTIVE'");

        for (const t of tenants) {
          try {
            const db = await dbManager.getTenantDb(t.id);
            // Search for active deliveries assigned to this driver which are not yet delivered
            const activeOrder = await dbManager.dbGet(db, `
              SELECT d.order_id, o.customer_id 
              FROM deliveries d
              JOIN orders o ON d.order_id = o.id
              WHERE d.driver_id = ? AND d.status IN ('ACCEPTED', 'PICKED_UP')
            `, [driverId]);

            if (activeOrder) {
              sendToUser(activeOrder.customer_id, {
                event: 'driver_location',
                data: {
                  orderId: activeOrder.order_id,
                  tenantId: t.id,
                  lat,
                  lng
                }
              });
            }
          } catch (e) {
            console.error('WS driver coordinates routing error:', e);
          }
        }
      }
    } catch (e) {
      console.error('WS Message Processing Exception:', e);
    }
  });

  ws.on('close', () => {
    if (authenticatedUser) {
      delete wsClients[authenticatedUser.id];
      console.log(`WS session disconnected for user: ${authenticatedUser.email}`);
    }
  });
});

// SPA Wildcard fallback routing for all virtual page reloads
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API route not found' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Run server initialization
dbManager.initPlatformDb().then(() => {
  server.listen(PORT, () => {
    console.log(`================================================================`);
    console.log(`🚀 Multi-Tenant SaaS Delivery Server running at http://localhost:${PORT}`);
    console.log(`================================================================`);
  });
}).catch(err => {
  console.error('Fatal initialization error:', err);
});

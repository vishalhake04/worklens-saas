/* ==========================================================================
   Work Lens Frontend Application Controller (SPA Simulator)
   ========================================================================== */

// Global App State
const state = {
  activeRole: 'PLATFORM_ADMIN',
  token: null,
  user: null,
  socket: null,
  
  // Platform Admin Data
  tenants: [],
  platformAdminToken: localStorage.getItem('platformAdminToken'),
  platformAdminUser: JSON.parse(localStorage.getItem('platformAdminUser') || 'null'),

  // Tenant Admin Data
  activeTenantId: 'tenant_1',
  tenantOrders: [],
  tenantMenu: [],
  editingDishImages: [], // Holds array of uploaded photo paths for the dish form
  activeDetailPhotoIndex: 0, // Current active image index in the details slider
  tenantToken: localStorage.getItem('tenantToken'),
  tenantUser: JSON.parse(localStorage.getItem('tenantUser') || 'null'),

  // Consumer Data
  restaurants: [],
  selectedRestaurant: null,
  selectedMenu: [],
  cart: {
    restaurantId: null,
    items: [], // { menuItemId, name, quantity, basePriceCents, selectedModifiers: [], selectedModifiersNames: [], totalItemPriceCents }
    subtotal: 0,
    delivery: 0,
    tax: 0,
    total: 0
  },
  activeTrackingOrder: null, // { orderId, status, restLat, restLng, custLat, custLng, driverLat, driverLng, driverName }
  consumerToken: localStorage.getItem('consumerToken'),
  consumerUser: JSON.parse(localStorage.getItem('consumerUser') || 'null'),

  // Driver Data
  activeDriverId: 'usr_driver_1',
  driverStatus: 'OFFLINE',
  driverLocation: { lat: 40.7100, lng: -74.0150 }, // Starting point
  activeOffer: null,
  activeTrip: null, // { tenantId, orderId, restLat, restLng, destLat, destLng, status }
  tripSimulationInterval: null,
  driverToken: localStorage.getItem('driverToken'),
  driverUser: JSON.parse(localStorage.getItem('driverUser') || 'null')
};

// Default Simulated Logins
const DEFAULT_USERS = {
  'PLATFORM_ADMIN': { email: 'admin@saas.com', password: 'password123' },
  'TENANT_ADMIN': {
    'tenant_1': { email: 'admin@pizzahub.com', password: 'password123' },
    'tenant_2': { email: 'admin@burgerbyte.com', password: 'password123' }
  },
  'CONSUMER': { email: 'diner@foodie.com', password: 'password123' },
  'DRIVER': {
    'usr_driver_1': { email: 'driver1@delivery.com', password: 'password123' },
    'usr_driver_2': { email: 'driver2@delivery.com', password: 'password123' }
  }
};

// Map canvas variables
let mapCanvas = null;
let mapCtx = null;

// ==========================================
// INITIALIZATION
// ==========================================

// Resolve Subdomain from Window Location
function getSubdomain() {
  const host = window.location.hostname.toLowerCase(); // e.g. "tenant_1.localhost" or "localhost"
  const parts = host.split('.');
  
  // 1. Localhost subdomains (e.g. tenant_1.localhost)
  if (parts.length === 2 && parts[1] === 'localhost' && parts[0] !== 'www') {
    return parts[0];
  }
  
  // 2. Wildcard nip.io subdomains (e.g. tenant_1.16.170.251.215.nip.io)
  if (host.endsWith('.nip.io') && parts.length === 7 && parts[0] !== 'www') {
    return parts[0];
  }
  
  // 3. Custom domain subdomains (e.g. tenant_1.yourdomain.com)
  if (parts.length === 3 && parts[1] !== 'nip' && parts[0] !== 'www') {
    return parts[0];
  }
  
  return null;
}

// Display block page for mismatched domain access attempts
function showDomainBlockedMessage(msg) {
  // Hide main header and container
  const header = document.querySelector('.app-header');
  if (header) header.style.display = 'none';
  
  const container = document.querySelector('.app-container');
  if (container) container.style.display = 'none';
  
  document.querySelectorAll('.view-panel').forEach(p => p.classList.remove('active'));
  
  // Render blocked layout
  const overlay = document.getElementById('domainBlockedOverlay');
  if (overlay) {
    overlay.style.display = 'flex';
    document.getElementById('domainBlockedText').innerText = msg;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  initUIHandlers();
  
  const subdomain = getSubdomain();
  const path = window.location.pathname;

  // Domain context validation (Security Boundary Checks)
  if (!subdomain) {
    // We are on the MAIN DOMAIN
    if (path === '/tenant-admin' || path === '/driver' || path === '/storefront') {
      showDomainBlockedMessage("Access Denied: Mismatched domain context. Tenant Admins, Consumers, and Drivers must access the system via their respective restaurant subdomains (e.g., tenant_1.localhost:3000).");
      return;
    }
  } else {
    // We are on a TENANT SUBDOMAIN
    if (path === '/platform-admin') {
      showDomainBlockedMessage("Access Denied: The Platform Admin console must only be accessed from the main domain (e.g., localhost:3000).");
      return;
    }
  }

  // Resolve role from URL pathname
  if (path === '/platform-admin') {
    state.activeRole = 'PLATFORM_ADMIN';
  } else if (path === '/tenant-admin') {
    state.activeRole = 'TENANT_ADMIN';
  } else if (path === '/driver') {
    state.activeRole = 'DRIVER';
  } else if (path === '/storefront') {
    state.activeRole = 'CONSUMER';
  }

  if (subdomain) {
    state.activeTenantId = subdomain;
    // Storefront subdomains default to Consumer, unless specifically visiting a role path
    if (path !== '/tenant-admin' && path !== '/driver') {
      state.activeRole = 'CONSUMER';
    }
    
    // Hide Platform Admin role button
    const platformAdminBtn = document.querySelector('.role-btn[data-role="PLATFORM_ADMIN"]');
    if (platformAdminBtn) platformAdminBtn.style.display = 'none';

    // Hide Tenant Switcher Select in Tenant Admin view
    const tenantSwitcher = document.querySelector('.tenant-switcher');
    if (tenantSwitcher) tenantSwitcher.style.display = 'none';
  }

  // Set switcher active button
  document.querySelectorAll('.role-btn').forEach(btn => btn.classList.remove('active'));
  const activeBtn = document.querySelector(`.role-btn[data-role="${state.activeRole}"]`);
  if (activeBtn) activeBtn.classList.add('active');

  // Auto login default user matching URL-determined role
  loginAndSwitchRole(state.activeRole);
});

function initUIHandlers() {
  // Role Switcher Navigation
  document.querySelectorAll('.role-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const targetRole = e.target.getAttribute('data-role');
      document.querySelectorAll('.role-btn').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      
      // Update URL Path matching target role
      let newPath = '/';
      if (targetRole === 'PLATFORM_ADMIN') newPath = '/platform-admin';
      else if (targetRole === 'TENANT_ADMIN') newPath = '/tenant-admin';
      else if (targetRole === 'DRIVER') newPath = '/driver';
      else if (targetRole === 'CONSUMER') newPath = '/storefront';
      
      history.pushState(null, '', newPath);
      
      loginAndSwitchRole(targetRole);
    });
  });

  // Onboard Tenant Form
  document.getElementById('onboardTenantForm').addEventListener('submit', handleOnboardTenantSubmit);

  // Platform Admin Tab Switching
  document.getElementById('platformTenantListTabBtn').addEventListener('click', () => {
    switchPlatformTab('LIST');
  });
  document.getElementById('platformAddTenantTabBtn').addEventListener('click', () => {
    switchPlatformTab('ADD');
  });

  // Tenant select switcher
  document.getElementById('activeTenantSelect').addEventListener('change', (e) => {
    state.activeTenantId = e.target.value;
    refreshTenantDashboard();
  });

  // Driver Auth forms switcher links
  document.getElementById('showDriverRegisterBtn').addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('driverLoginForm').style.display = 'none';
    document.getElementById('driverRegisterForm').style.display = 'block';
    document.getElementById('driverAuthTitle').innerText = 'Register as Driver';
    document.getElementById('driverAuthSubtitle').innerText = 'Join Work Lens platform to deliver food.';
    document.getElementById('driverAuthStatusMessage').innerText = '';
  });

  document.getElementById('showDriverLoginBtn').addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('driverRegisterForm').style.display = 'none';
    document.getElementById('driverLoginForm').style.display = 'block';
    document.getElementById('driverAuthTitle').innerText = 'Driver Partner Login';
    document.getElementById('driverAuthSubtitle').innerText = 'Sign in to accept delivery jobs and track routes.';
    document.getElementById('driverAuthStatusMessage').innerText = '';
  });

  // Driver Login Form Submit
  document.getElementById('driverLoginForm').addEventListener('submit', handleDriverLoginSubmit);

  // Driver Register Form Submit
  document.getElementById('driverRegisterForm').addEventListener('submit', handleDriverRegisterSubmit);

  // Driver Logout Button Click
  document.getElementById('driverLogoutBtn').addEventListener('click', (e) => {
    e.preventDefault();
    state.driverToken = null;
    state.driverUser = null;
    localStorage.removeItem('driverToken');
    localStorage.removeItem('driverUser');
    loginAndSwitchRole('DRIVER');
  });

  // Basket checkout button
  document.getElementById('checkoutBtn').addEventListener('click', handleCartCheckout);

  // Fulfillment option change
  const cartFulfillSelect = document.getElementById('cartFulfillmentType');
  if (cartFulfillSelect) {
    cartFulfillSelect.addEventListener('change', () => {
      recalculateCart();
    });
  }

  // Consumer back button
  document.getElementById('backToStoresBtn').addEventListener('click', () => {
    document.getElementById('storefrontMenuPanel').style.display = 'none';
    document.getElementById('storefrontDiscoverPanel').style.display = 'block';
  });

  // Close tracking button
  document.getElementById('closeTrackingBtn').addEventListener('click', () => {
    document.getElementById('orderTrackingPanel').style.display = 'none';
    const consumerGrid = document.querySelector('.consumer-grid');
    consumerGrid.classList.remove('tracking-active');
    state.activeTrackingOrder = null;
    
    // Refresh dashboard layout to display correct menu list/subdomain context
    loginAndSwitchRole('CONSUMER');
  });

  // Driver Online toggle button
  document.getElementById('driverToggleOnlineBtn').addEventListener('click', handleDriverOnlineToggle);

  // Driver offers buttons
  document.getElementById('acceptOfferBtn').addEventListener('click', () => handleOfferResponse('ACCEPT'));
  document.getElementById('rejectOfferBtn').addEventListener('click', () => handleOfferResponse('REJECT'));

  // Driver Trip simulation buttons
  document.getElementById('simulatePickupBtn').addEventListener('click', startSimulationToRestaurant);
  document.getElementById('markPickedUpBtn').addEventListener('click', markOrderPickedUp);
  document.getElementById('simulateDeliveryBtn').addEventListener('click', startSimulationToCustomer);
  document.getElementById('markDeliveredBtn').addEventListener('click', markOrderDelivered);

  // Canvas context
  mapCanvas = document.getElementById('liveTrackingMap');
  mapCtx = mapCanvas.getContext('2d');

  // Modal handlers
  document.getElementById('closeModalBtn').addEventListener('click', () => {
    document.getElementById('modifierModal').style.display = 'none';
  });

  // Consumer Auth Modal open/close
  document.getElementById('consumerHeaderLoginBtn').addEventListener('click', () => {
    document.getElementById('consumerAuthModal').style.display = 'block';
  });
  document.getElementById('closeConsumerAuthModalBtn').addEventListener('click', () => {
    document.getElementById('consumerAuthModal').style.display = 'none';
  });

  // Consumer Auth forms switcher links
  document.getElementById('showRegisterBtn').addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('consumerLoginForm').style.display = 'none';
    document.getElementById('consumerRegisterForm').style.display = 'block';
    document.getElementById('consumerAuthTitle').innerText = 'Create Account';
    document.getElementById('consumerAuthSubtitle').innerText = 'Join Work Lens platform to order food.';
    document.getElementById('consumerAuthStatusMessage').innerText = '';
  });

  document.getElementById('showLoginBtn').addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('consumerRegisterForm').style.display = 'none';
    document.getElementById('consumerLoginForm').style.display = 'block';
    document.getElementById('consumerAuthTitle').innerText = 'Diner Login';
    document.getElementById('consumerAuthSubtitle').innerText = 'Sign in to place orders and track deliveries.';
    document.getElementById('consumerAuthStatusMessage').innerText = '';
  });

  // Consumer Login Form Submit
  document.getElementById('consumerLoginForm').addEventListener('submit', handleConsumerLoginSubmit);

  // Consumer Register Form Submit
  document.getElementById('consumerRegisterForm').addEventListener('submit', handleConsumerRegisterSubmit);

  // Consumer Logout buttons
  const handleLogout = (e) => {
    e.preventDefault();
    state.consumerToken = null;
    state.consumerUser = null;
    localStorage.removeItem('consumerToken');
    localStorage.removeItem('consumerUser');
    loginAndSwitchRole('CONSUMER');
  };
  document.getElementById('consumerHeaderLogoutBtn').addEventListener('click', handleLogout);

  // Consumer tab switch listeners
  document.getElementById('consumerStoresTabBtn').addEventListener('click', () => {
    switchConsumerTab('STORES');
  });
  document.getElementById('consumerHistoryTabBtn').addEventListener('click', () => {
    switchConsumerTab('HISTORY');
  });

  // Add Dish Button Click
  document.getElementById('addDishBtn').addEventListener('click', openAddDishModal);

  // Close Dish Modal Button Click
  document.getElementById('closeDishModalBtn').addEventListener('click', () => {
    document.getElementById('dishModal').style.display = 'none';
  });

  // Close Tenant Dish Detail Modal
  document.getElementById('closeDishDetailModalBtn').addEventListener('click', () => {
    document.getElementById('dishDetailModal').style.display = 'none';
  });

  // Save Dish Form Submit (triggered by clicking Save button)
  document.getElementById('saveDishSubmitBtn').addEventListener('click', (e) => {
    e.preventDefault();
    handleDishFormSubmit();
  });

  // Upload Dish Photo Click Listener
  document.getElementById('uploadPhotoBtn').addEventListener('click', handleDishPhotoUpload);

  // Delete Dish Submit Click
  document.getElementById('deleteDishSubmitBtn').addEventListener('click', handleDeleteDishSubmit);

  // Close Tenant Edit Modal Button
  document.getElementById('closeTenantEditModalBtn').addEventListener('click', () => {
    document.getElementById('tenantEditModal').style.display = 'none';
  });

  // Save Tenant Edit Form Submit
  document.getElementById('saveTenantEditSubmitBtn').addEventListener('click', (e) => {
    e.preventDefault();
    handleTenantEditFormSubmit();
  });

  // Tenant Login Form Submit
  document.getElementById('tenantLoginForm').addEventListener('submit', handleTenantLoginSubmit);

  // Tenant tab navigation triggers
  document.getElementById('tenantOrdersTabBtn').addEventListener('click', () => {
    switchTenantTab('ORDERS');
  });
  document.getElementById('tenantMenuTabBtn').addEventListener('click', () => {
    switchTenantTab('MENU');
  });
  document.getElementById('tenantConsumersTabBtn').addEventListener('click', () => {
    switchTenantTab('CONSUMERS');
  });

  document.getElementById('tenantSettingsTabBtn').addEventListener('click', () => {
    switchTenantTab('SETTINGS');
  });

  const tenantSettingsForm = document.getElementById('tenantSettingsForm');
  if (tenantSettingsForm) {
    tenantSettingsForm.addEventListener('submit', handleTenantSettingsSubmit);
  }

  // Tenant Logout Button Click
  document.getElementById('tenantLogoutBtn').addEventListener('click', (e) => {
    e.preventDefault();
    state.tenantToken = null;
    state.tenantUser = null;
    localStorage.removeItem('tenantToken');
    localStorage.removeItem('tenantUser');
    loginAndSwitchRole('TENANT_ADMIN');
  });

  // Platform Admin Login Form Submit
  document.getElementById('platformLoginForm').addEventListener('submit', handlePlatformLoginSubmit);

  // Platform Admin Logout Button Click
  document.getElementById('platformLogoutBtn').addEventListener('click', (e) => {
    e.preventDefault();
    state.platformAdminToken = null;
    state.platformAdminUser = null;
    localStorage.removeItem('platformAdminToken');
    localStorage.removeItem('platformAdminUser');
    loginAndSwitchRole('PLATFORM_ADMIN');
  });

  // Add Category Button Click
  document.getElementById('addCategoryBtn').addEventListener('click', () => {
    document.getElementById('categoryForm').reset();
    document.getElementById('categoryFormStatusMessage').innerText = '';
    document.getElementById('categoryModal').style.display = 'flex';
  });

  // Close Category Modal Button
  document.getElementById('closeCategoryModalBtn').addEventListener('click', () => {
    document.getElementById('categoryModal').style.display = 'none';
  });

  // Save Category Form Submit
  document.getElementById('saveCategorySubmitBtn').addEventListener('click', (e) => {
    e.preventDefault();
    handleCategoryFormSubmit();
  });

  // Basket Payment Method Select Change Listener
  document.getElementById('cartPaymentMethod').addEventListener('change', (e) => {
    const method = e.target.value;
    const btn = document.getElementById('checkoutBtn');
    
    // Toggle sub-form displays
    document.getElementById('cardDetailsForm').style.display = method === 'CARD' ? 'block' : 'none';
    document.getElementById('upiDetailsForm').style.display = method === 'UPI' ? 'block' : 'none';
    document.getElementById('codDetailsForm').style.display = method === 'COD' ? 'block' : 'none';
    
    if (method === 'UPI') btn.innerText = 'Place Order (UPI Transfer)';
    else if (method === 'COD') btn.innerText = 'Place Order (Cash on Delivery)';
    else btn.innerText = 'Place Order (Mock Stripe Pay)';
  });
}

// ==========================================
// AUTHENTICATION & WEBSOCKET SETUP
// ==========================================

async function loginAndSwitchRole(role) {
  state.activeRole = role;

  // Reset top-right header auth buttons visibility
  const headerLoginBtn = document.getElementById('consumerHeaderLoginBtn');
  const headerLogoutBtn = document.getElementById('consumerHeaderLogoutBtn');
  const headerPlatformLogout = document.getElementById('platformLogoutBtn');
  const headerDriverLogout = document.getElementById('driverLogoutBtn');
  if (headerLoginBtn) headerLoginBtn.style.display = 'none';
  if (headerLogoutBtn) headerLogoutBtn.style.display = 'none';
  if (headerPlatformLogout) headerPlatformLogout.style.display = 'none';
  if (headerDriverLogout) headerDriverLogout.style.display = 'none';

  // Handle PLATFORM_ADMIN role (requires Auth Gate logic)
  if (role === 'PLATFORM_ADMIN') {
    // Switch Panel Views
    document.querySelectorAll('.view-panel').forEach(p => p.classList.remove('active'));
    document.getElementById(`panel-${role}`).classList.add('active');

    if (!state.platformAdminToken) {
      // Show login form, hide platform main dashboard
      document.getElementById('platformAuthGate').style.display = 'block';
      document.getElementById('platformMainDashboard').style.display = 'none';
      document.getElementById('currentUserLabel').innerText = 'Guest Platform (Logged Out)';
      state.token = null;
      state.user = null;
      if (state.socket) {
        state.socket.close();
        state.socket = null;
      }
    } else {
      // Show main app, hide auth gate
      document.getElementById('platformAuthGate').style.display = 'none';
      document.getElementById('platformMainDashboard').style.display = 'block';
      
      state.token = state.platformAdminToken;
      state.user = state.platformAdminUser;
      
      document.getElementById('currentUserLabel').innerText = `${state.user.firstName} (${state.user.role})`;
      if (headerPlatformLogout) headerPlatformLogout.style.display = 'inline-block';
      
      connectWebSocket();
      switchPlatformTab('LIST');
    }
    return;
  }

  // Handle CONSUMER role (requires Auth Gate logic instead of auto-login)
  if (role === 'CONSUMER') {
    // Switch Panel Views
    document.querySelectorAll('.view-panel').forEach(p => p.classList.remove('active'));
    document.getElementById(`panel-${role}`).classList.add('active');

    // Switch View to main dashboard always (can browse/add to cart without logging in!)
    document.getElementById('consumerMainDashboard').style.display = 'grid';

    if (!state.consumerToken) {
      document.getElementById('currentUserLabel').innerText = 'Guest Diner (Logged Out)';
      document.getElementById('consumerHeaderLoginBtn').style.display = 'inline-block'; // Show manual login button
      document.getElementById('consumerHeaderLogoutBtn').style.display = 'none'; // Hide manual logout button
      state.token = null;
      state.user = null;
      
      // Clear socket if exists
      if (state.socket) {
        state.socket.close();
        state.socket = null;
      }

      // Allow viewing storefront stores selection
      switchConsumerTab('STORES');
      refreshConsumerDashboard();
    } else {
      document.getElementById('consumerHeaderLoginBtn').style.display = 'none'; // Hide manual login button
      document.getElementById('consumerHeaderLogoutBtn').style.display = 'inline-block'; // Show manual logout button
      
      state.token = state.consumerToken;
      state.user = state.consumerUser;
      
      document.getElementById('currentUserLabel').innerText = `${state.user.firstName} (${state.user.role})`;
      
      // Keep or default tab
      if (!state.activeConsumerTab) {
        switchConsumerTab('STORES');
      } else {
        switchConsumerTab(state.activeConsumerTab);
      }
      
      connectWebSocket();
      refreshConsumerDashboard();
    }
    return;
  }

  // Handle TENANT_ADMIN role (requires Auth Gate logic instead of auto-login)
  if (role === 'TENANT_ADMIN') {
    // Switch Panel Views
    document.querySelectorAll('.view-panel').forEach(p => p.classList.remove('active'));
    document.getElementById(`panel-${role}`).classList.add('active');

    if (!state.tenantToken) {
      // Show login form, hide tenant main app
      document.getElementById('tenantAuthGate').style.display = 'block';
      document.getElementById('tenantMainDashboard').style.display = 'none';
      document.getElementById('tenantTabsGroup').style.display = 'none';
      document.getElementById('currentUserLabel').innerText = 'Guest Tenant (Logged Out)';
      document.getElementById('activeTenantSelect').disabled = false;
      
      state.token = null;
      state.user = null;
      if (state.socket) {
        state.socket.close();
        state.socket = null;
      }
    } else {
      // Show main app, hide auth gate
      document.getElementById('tenantAuthGate').style.display = 'none';
      document.getElementById('tenantMainDashboard').style.display = 'block';
      document.getElementById('tenantTabsGroup').style.display = 'flex';
      
      state.token = state.tenantToken;
      state.user = state.tenantUser;
      
      // Sync and lock tenant dropdown selection
      state.activeTenantId = state.user.tenantId;
      const select = document.getElementById('activeTenantSelect');
      select.value = state.user.tenantId;
      select.disabled = true;

      document.getElementById('currentUserLabel').innerText = `${state.user.firstName} (${state.user.role})`;
      
      // Select orders tab by default
      switchTenantTab('ORDERS');

      connectWebSocket();
      refreshTenantDashboard();
    }
    return;
  }

  // Handle DRIVER role (requires Auth Gate logic)
  if (role === 'DRIVER') {
    // Switch Panel Views
    document.querySelectorAll('.view-panel').forEach(p => p.classList.remove('active'));
    document.getElementById(`panel-${role}`).classList.add('active');

    if (!state.driverToken) {
      // Show login form, hide driver main app
      document.getElementById('driverAuthGate').style.display = 'block';
      document.getElementById('driverMainDashboard').style.display = 'none';
      document.getElementById('currentUserLabel').innerText = 'Guest Driver (Logged Out)';
      
      state.token = null;
      state.user = null;
      if (state.socket) {
        state.socket.close();
        state.socket = null;
      }
    } else {
      // Show main app, hide auth gate
      document.getElementById('driverAuthGate').style.display = 'none';
      document.getElementById('driverMainDashboard').style.display = 'block';
      
      state.token = state.driverToken;
      state.user = state.driverUser;
      
      document.getElementById('currentUserLabel').innerText = `${state.user.firstName} (${state.user.role})`;
      if (headerDriverLogout) headerDriverLogout.style.display = 'inline-block';
      
      connectWebSocket();
      refreshDriverDashboard();
    }
    return;
  }
}

function handleInvalidToken(role) {
  if (role === 'PLATFORM_ADMIN') {
    state.platformAdminToken = null;
    state.platformAdminUser = null;
    localStorage.removeItem('platformAdminToken');
    localStorage.removeItem('platformAdminUser');
  } else if (role === 'TENANT_ADMIN') {
    state.tenantToken = null;
    state.tenantUser = null;
    localStorage.removeItem('tenantToken');
    localStorage.removeItem('tenantUser');
  } else if (role === 'CONSUMER') {
    state.consumerToken = null;
    state.consumerUser = null;
    localStorage.removeItem('consumerToken');
    localStorage.removeItem('consumerUser');
  } else if (role === 'DRIVER') {
    state.driverToken = null;
    state.driverUser = null;
    localStorage.removeItem('driverToken');
    localStorage.removeItem('driverUser');
  }
  state.token = null;
  state.user = null;
  loginAndSwitchRole(role);
}

function connectWebSocket() {
  if (state.socket) {
    state.socket.close();
  }

  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  state.socket = new WebSocket(`${protocol}://${window.location.host}`);

  state.socket.onopen = () => {
    // Authenticate WS Session immediately
    state.socket.send(JSON.stringify({
      action: 'authenticate',
      token: state.token
    }));
  };

  state.socket.onmessage = (event) => {
    const payload = JSON.parse(event.data);
    handleWebSocketEvent(payload);
  };

  state.socket.onclose = () => {
    console.log('WS disconnected.');
  };
}

function handleWebSocketEvent(payload) {
  const { event, data } = payload;
  console.log(`Received WS event [${event}]:`, data);

  // 1. Order status changes (Consumer & Tenant views)
  if (event === 'order_update') {
    if (state.activeRole === 'TENANT_ADMIN' && data.tenantId === state.activeTenantId) {
      refreshTenantDashboard();
    }
    
    // If consumer is actively tracking this order ID
    if (state.activeRole === 'CONSUMER' && state.activeTrackingOrder && state.activeTrackingOrder.orderId === data.orderId) {
      state.activeTrackingOrder.status = data.status;
      updateTrackingProgressSteps(data.status);
      
      if (data.status === 'DELIVERED') {
        clearInterval(state.tripSimulationInterval);
        state.activeTrackingOrder.driverLat = state.activeTrackingOrder.custLat;
        state.activeTrackingOrder.driverLng = state.activeTrackingOrder.custLng;
        renderTrackingMap();
      }
    }
  }

  // 2. Delivery Driver assignments (Consumer view)
  if (event === 'delivery_update') {
    if (state.activeRole === 'CONSUMER' && state.activeTrackingOrder && state.activeTrackingOrder.orderId === data.orderId) {
      state.activeTrackingOrder.driverName = data.driverName;
      document.getElementById('trackingDriverLabel').innerText = `Delivery Partner: ${data.driverName} (Assigned)`;
    }
  }

  // 3. Driver Live Location changes (Consumer map tracking)
  if (event === 'driver_location') {
    if (state.activeRole === 'CONSUMER' && state.activeTrackingOrder && state.activeTrackingOrder.orderId === data.orderId) {
      state.activeTrackingOrder.driverLat = data.lat;
      state.activeTrackingOrder.driverLng = data.lng;
      renderTrackingMap();
    }
  }

  // 4. Logistics dispatch offer alert (Driver view)
  if (event === 'delivery_offer') {
    if (state.activeRole === 'DRIVER' && state.driverStatus === 'ONLINE') {
      showDriverOfferAlert(data);
    }
  }

  // 5. Driver Sync coordinates on connection
  if (event === 'location_sync') {
    state.driverLocation.lat = data.lat;
    state.driverLocation.lng = data.lng;
    state.driverStatus = data.status;
    updateDriverUIState();
  }
}

// ==========================================
// PLATFORM ADMIN DASHBOARD
// ==========================================

async function refreshPlatformAdminDashboard() {
  try {
    const response = await fetch('/api/admin/tenants', {
      headers: { 'Authorization': `Bearer ${state.token}` }
    });
    const tenants = await response.json();
    if (response.status === 401 || response.status === 403) {
      handleInvalidToken('PLATFORM_ADMIN');
      return;
    }
    state.tenants = tenants;

    const tbody = document.querySelector('#tenantsTable tbody');
    tbody.innerHTML = '';

    tenants.forEach(tenant => {
      const tr = document.createElement('tr');
      
      let statusDotClass = 'green';
      if (tenant.status === 'PENDING') statusDotClass = 'amber';
      else if (tenant.status === 'SUSPENDED') statusDotClass = 'red';

      tr.innerHTML = `
        <td><strong>${tenant.id}</strong></td>
        <td>${tenant.business_name}</td>
        <td><a href="http://${tenant.domain}:3000" target="_blank" class="text-btn">${tenant.domain}</a></td>
        <td>${tenant.email || '-'}</td>
        <td>${tenant.phone || '-'}</td>
        <td><code>tenant_${tenant.id}.db</code></td>
        <td><span class="badge ${tenant.subscription_tier === 'BASIC' ? 'pending' : 'active'}">${tenant.subscription_tier}</span></td>
        <td>${tenant.ordersCount} orders</td>
        <td><span class="status-dot ${statusDotClass}"></span> ${tenant.status}</td>
        <td><button class="text-btn" style="font-size: 11px; padding: 4px;" onclick="openTenantEditModal('${tenant.id}')">Edit</button></td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    console.error('Error fetching tenants:', err);
  }
}

async function handleOnboardTenantSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('newTenantId').value.trim();
  const businessName = document.getElementById('newTenantName').value.trim();
  const domain = document.getElementById('newTenantDomain').value.trim();
  const email = document.getElementById('newTenantEmail').value.trim();
  const phone = document.getElementById('newTenantPhone').value.trim();
  const address = document.getElementById('newTenantAddress').value.trim();
  const latitude = parseFloat(document.getElementById('newTenantLat').value);
  const longitude = parseFloat(document.getElementById('newTenantLng').value);
  const subscriptionTier = document.getElementById('newTenantTier').value;

  const msgDiv = document.getElementById('onboardStatusMessage');
  msgDiv.className = 'status-message';
  msgDiv.innerText = 'Provisioning databases and resources...';

  try {
    const response = await fetch('/api/admin/tenants', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.token}`
      },
      body: JSON.stringify({ id, businessName, domain, subscriptionTier, email, phone, address, latitude, longitude })
    });
    const data = await response.json();

    if (data.error) {
      msgDiv.className = 'status-message error-message';
      msgDiv.innerText = `Error: ${data.error}`;
      return;
    }

    msgDiv.className = 'status-message success-message';
    msgDiv.innerHTML = `
      <strong>Success!</strong> Tenant dynamic database setup complete.<br>
      Admin Login Email: <code>${data.adminEmail}</code><br>
      Admin Login Mobile: <code>${phone}</code><br>
      Password: <code>${data.adminPassword}</code>
    `;
    
    // Reset form
    document.getElementById('onboardTenantForm').reset();
    
    // Add new option to Tenant selects dynamically
    const tenantSelect = document.getElementById('activeTenantSelect');
    const option = document.createElement('option');
    option.value = id;
    option.text = `${businessName} (${id})`;
    tenantSelect.appendChild(option);

    refreshPlatformAdminDashboard();
  } catch (err) {
    msgDiv.className = 'status-message error-message';
    msgDiv.innerText = `Provisioning exception: ${err.message}`;
  }
}

// ==========================================
// TENANT ADMIN DASHBOARD
// ==========================================

async function refreshTenantDashboard() {
  try {
    const headers = {
      'Authorization': `Bearer ${state.token}`,
      'X-Tenant-ID': state.activeTenantId
    };

    // 1. Fetch Orders
    const ordersRes = await fetch('/api/tenant/orders', { headers });
    const ordersData = await ordersRes.json();
    if (ordersRes.status === 401 || ordersRes.status === 403) {
      handleInvalidToken('TENANT_ADMIN');
      return;
    }
    state.tenantOrders = ordersData;
    renderTenantOrders();

    // 2. Fetch Menu
    const menuRes = await fetch(`/api/storefront/restaurants/${state.activeTenantId}/menu`);
    state.tenantMenu = await menuRes.json();
    renderTenantMenu();

  } catch (err) {
    console.error('Error refreshing Tenant Dashboard:', err);
  }
}

function renderTenantOrders() {
  const tbody = document.querySelector('#tenantOrdersTable tbody');
  tbody.innerHTML = '';

  if (state.tenantOrders.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-message">No orders received yet for this store partition.</td></tr>';
    return;
  }

  state.tenantOrders.forEach(o => {
    const itemsSummary = o.items.map(i => {
      const mods = i.modifiers.map(m => m.modifier_name).join(', ');
      return `${i.quantity}x ${i.menu_item_name} ${mods ? `(${mods})` : ''}`;
    }).join('<br>');

    // Calculate payouts
    const commission = o.platform_commission_cents / 100;
    const deliveryFee = o.delivery_fee_cents / 100;
    const total = o.total_cents / 100;
    const platformShare = commission + deliveryFee;
    const tenantShare = total - platformShare;

    // Action button depends on FSM
    let actionBtnHtml = '';
    if (o.status === 'PLACED') {
      actionBtnHtml = `<button class="primary-btn green-btn" onclick="transitionOrderStatus('${o.id}', 'ACCEPTED')">Accept Order</button>`;
    } else if (o.status === 'ACCEPTED') {
      actionBtnHtml = `<button class="primary-btn" onclick="transitionOrderStatus('${o.id}', 'PREPARING')">Start Cooking</button>`;
    } else if (o.status === 'PREPARING') {
      actionBtnHtml = `<button class="primary-btn amber-btn" style="background-color: var(--accent-amber); color: black;" onclick="transitionOrderStatus('${o.id}', 'READY')">Food Prepared</button>`;
    } else if (o.status === 'READY') {
      if (o.fulfillment_type === 'PICKUP') {
        actionBtnHtml = `<button class="primary-btn green-btn" onclick="transitionOrderStatus('${o.id}', 'DELIVERED')">Complete Pickup</button>`;
      } else {
        actionBtnHtml = `<span class="badge pending">Awaiting Delivery Partner Pickup</span>`;
      }
    } else if (o.status === 'DISPATCHED') {
      actionBtnHtml = `<span class="badge active">Out for Delivery</span>`;
    } else if (o.status === 'DELIVERED') {
      actionBtnHtml = `<span class="status-dot green"></span> Completed`;
    } else if (o.status === 'CANCELLED') {
      actionBtnHtml = `<span class="status-dot red"></span> Cancelled`;
    }

    const driverName = o.delivery ? `Driver #${o.delivery.driver_id}` : 'Unassigned';
    let logisticsHtml = '';
    if (o.fulfillment_type === 'PICKUP') {
      logisticsHtml = `<span class="badge warning" style="background: rgba(16, 185, 129, 0.1); color: var(--accent-green); border: 1px solid var(--accent-green);">Self Pickup Pass: <strong>${o.pickup_code}</strong></span>`;
    } else {
      if (o.status === 'PLACED') {
        logisticsHtml = 'Waiting acceptance';
      } else if (o.status === 'ACCEPTED' || o.status === 'PREPARING') {
        logisticsHtml = `<span class="badge pending">${o.delivery ? `${o.delivery.status}` : 'Searching for Drivers...'}</span>`;
      } else {
        logisticsHtml = `<span class="badge active">${o.delivery ? `${o.delivery.status} (${driverName})` : 'Self pickup'}</span>`;
      }
    }

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${o.id}</strong></td>
      <td>${itemsSummary}</td>
      <td><strong>₹${total.toFixed(2)}</strong></td>
      <td>
        <span style="font-size: 11px; display: block; color: var(--text-secondary)">Tenant: ₹${tenantShare.toFixed(2)}</span>
        <span style="font-size: 11px; display: block; color: var(--text-muted)">SaaS Split Fee: ₹${platformShare.toFixed(2)}</span>
      </td>
      <td><span class="badge ${o.status.toLowerCase()}">${o.status}</span></td>
      <td>${logisticsHtml}</td>
      <td>${actionBtnHtml}</td>
    `;
    tbody.appendChild(tr);
  });
}

function renderTenantMenu() {
  const container = document.getElementById('tenantMenuContainer');
  container.innerHTML = '';

  if (state.tenantMenu.length === 0) {
    container.innerHTML = '<p class="empty-message">No menu categories or items found. Click Add New Dish to get started.</p>';
    return;
  }

  state.tenantMenu.forEach(cat => {
    const catBlock = document.createElement('div');
    catBlock.className = 'menu-section-group';
    catBlock.innerHTML = `<h4>${cat.name}</h4>`;
    
    cat.items.forEach(item => {
      const itemRow = document.createElement('div');
      itemRow.className = 'menu-item-row';
      
      const priceText = item.discount_price_cents 
        ? `<span style="text-decoration: line-through; color: var(--text-muted); font-size: 11px;">₹${(item.base_price_cents/100).toFixed(2)}</span> <span style="color: var(--accent-green); font-weight: 600;">₹${(item.discount_price_cents/100).toFixed(2)}</span>`
        : `₹${(item.base_price_cents/100).toFixed(2)}`;

      const imgHtml = item.image_url 
        ? `<div style="width: 50px; height: 50px; overflow: hidden; border-radius: 6px; flex-shrink: 0; border: 1px solid var(--bg-tertiary);">
             <img src="${item.image_url}" alt="${item.name}" style="width: 100%; height: 100%; object-fit: cover;">
           </div>`
        : '';

      itemRow.innerHTML = `
        <div style="display: flex; gap: 10px; align-items: center; flex: 1; text-align: left; cursor: pointer;" onclick="openDishDetailModal('${cat.id}', '${item.id}')">
          ${imgHtml}
          <div class="menu-item-info">
            <h5 style="margin: 0;">${item.name} ${item.dietary_tag ? `<span class="badge" style="background-color: var(--bg-tertiary); color: var(--accent-blue); padding: 1px 6px; font-size: 9px; vertical-align: middle; margin-left: 5px;">${item.dietary_tag}</span>` : ''}</h5>
            <p style="margin: 4px 0 0 0; font-size: 12px; color: var(--text-secondary);">${priceText} - ${item.description || 'No description'}</p>
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 14px;">
          <button class="text-btn" style="font-size: 11px; padding: 4px;" onclick="openEditDishModal('${cat.id}', '${item.id}')">Edit</button>
          <label class="switch-control">
            <input type="checkbox" ${item.is_available ? 'checked' : ''} onchange="toggleItemAvailability('${item.id}', this.checked)">
            <span class="switch-slider"></span>
          </label>
        </div>
      `;
      catBlock.appendChild(itemRow);
    });

    container.appendChild(catBlock);
  });
}

// Global functions exposed to inline clicks (called from generated HTML tables)
window.transitionOrderStatus = async function(orderId, targetStatus) {
  let pickupCode = null;
  if (targetStatus === 'DELIVERED') {
    const order = state.tenantOrders.find(o => o.id === orderId);
    if (order && order.fulfillment_type === 'PICKUP') {
      pickupCode = prompt("Enter the 6-digit Customer Self-Pickup Pass Code to authorize delivery confirmation:");
      if (pickupCode === null) return; // User cancelled prompt
      if (!pickupCode.trim()) {
        alert("Verification code is required to complete self-pickup.");
        return;
      }
    }
  }

  try {
    const response = await fetch(`/api/tenant/orders/${orderId}/transition`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.token}`,
        'X-Tenant-ID': state.activeTenantId
      },
      body: JSON.stringify({ targetStatus, pickupCode })
    });
    const data = await response.json();
    if (data.error) {
      alert(`FSM Guard Exception: ${data.error}`);
    } else {
      refreshTenantDashboard();
    }
  } catch (err) {
    console.error(err);
  }
};

window.toggleItemAvailability = async function(itemId, isAvailable) {
  try {
    const response = await fetch(`/api/tenant/menu/items/${itemId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.token}`,
        'X-Tenant-ID': state.activeTenantId
      },
      body: JSON.stringify({ is_available: isAvailable })
    });
    await response.json();
  } catch (err) {
    console.error(err);
  }
};

// ==========================================
// CONSUMER / STOREFRONT DASHBOARD
// ==========================================

async function refreshConsumerDashboard() {
  const subdomain = getSubdomain();

  try {
    const response = await fetch('/api/storefront/restaurants');
    const brands = await response.json();
    state.restaurants = brands;

    if (subdomain) {
      // Find matching tenant storefront
      const matchedStore = brands.find(store => store.tenantId === subdomain);
      if (matchedStore) {
        // Bypass restaurant discovery, load this tenant storefront directly
        loadConsumerStoreMenu(matchedStore);
        // Hide back button since we are in single tenant mode
        const backBtn = document.getElementById('backToStoresBtn');
        if (backBtn) backBtn.style.display = 'none';
      } else {
        // Show empty message if not active
        const container = document.getElementById('consumerRestaurantList');
        container.innerHTML = `<p class="empty-message">Tenant storefront "${subdomain}" is not active or open.</p>`;
        document.getElementById('storefrontMenuPanel').style.display = 'none';
        document.getElementById('storefrontDiscoverPanel').style.display = 'block';
      }
      return;
    }

    const container = document.getElementById('consumerRestaurantList');
    container.innerHTML = '';

    brands.forEach(store => {
      const div = document.createElement('div');
      div.className = 'restaurant-card-item';
      div.innerHTML = `
        <h4>${store.name}</h4>
        <p>${store.address}</p>
      `;
      div.addEventListener('click', () => loadConsumerStoreMenu(store));
      container.appendChild(div);
    });
  } catch (err) {
    console.error('Error loading storefront list:', err);
  }
}

async function loadConsumerStoreMenu(store) {
  state.selectedRestaurant = store;
  document.getElementById('storefrontDiscoverPanel').style.display = 'none';
  document.getElementById('storefrontMenuPanel').style.display = 'block';

  document.getElementById('currentStoreName').innerText = store.name;
  document.getElementById('currentStoreAddress').innerText = store.address;

  // Toggle fulfillment options based on store settings
  const optDel = document.getElementById('fulfillmentOptionDelivery');
  const optPic = document.getElementById('fulfillmentOptionPickup');
  const selectFulfill = document.getElementById('cartFulfillmentType');
  
  if (optDel) optDel.disabled = (store.deliveryEnabled === 0);
  if (optPic) optPic.disabled = (store.pickupEnabled === 0);
  
  if (selectFulfill) {
    if (store.deliveryEnabled !== 0) {
      selectFulfill.value = 'DELIVERY';
    } else if (store.pickupEnabled !== 0) {
      selectFulfill.value = 'PICKUP';
    }
  }

  try {
    const response = await fetch(`/api/storefront/restaurants/${store.tenantId}/menu`);
    const menuTree = await response.json();
    state.selectedMenu = menuTree;

    const container = document.getElementById('consumerMenuContainer');
    container.innerHTML = '';

    menuTree.forEach(cat => {
      const catBlock = document.createElement('div');
      catBlock.className = 'menu-cat-block';
      catBlock.innerHTML = `<h4>${cat.name}</h4>`;
      
      const itemList = document.createElement('div');
      itemList.className = 'consumer-item-list';

      cat.items.forEach(item => {
        const itemCard = document.createElement('div');
        itemCard.className = 'consumer-item-card';

        const priceHtml = item.discount_price_cents
          ? `<span style="text-decoration: line-through; color: var(--text-muted); font-size: 11px; margin-right: 5px;">₹${(item.base_price_cents/100).toFixed(2)}</span>
             <span style="color: var(--accent-green); font-weight: 700;">₹${(item.discount_price_cents/100).toFixed(2)}</span>
             <span class="badge" style="background: rgba(16, 185, 129, 0.15); color: #34d399; font-size: 9px; padding: 1px 6px; margin-left: 5px; vertical-align: middle;">OFFER</span>`
          : `<span style="color: var(--accent-blue); font-weight: 700;">₹${(item.base_price_cents/100).toFixed(2)}</span>`;

        const imgHtml = item.image_url 
          ? `<div class="item-photo-wrapper" style="width: 70px; height: 70px; overflow: hidden; border-radius: 8px; flex-shrink: 0; border: 1px solid var(--bg-tertiary);">
               <img src="${item.image_url}" alt="${item.name}" style="width: 100%; height: 100%; object-fit: cover;">
             </div>`
          : '';

        itemCard.innerHTML = `
          <div style="display: flex; gap: 12px; width: 100%; align-items: start; text-align: left;">
            ${imgHtml}
            <div class="item-left" style="flex: 1;">
              <h5 style="margin: 0; display: flex; align-items: center; gap: 6px;">
                ${item.name} 
                ${item.dietary_tag ? `<span class="badge" style="background: var(--bg-secondary); color: var(--text-secondary); padding: 1px 6px; font-size: 8px;">${item.dietary_tag}</span>` : ''}
              </h5>
              <p style="margin-top: 4px; margin-bottom: 6px; font-size: 12px; color: var(--text-secondary); line-height: 1.4;">${item.description || ''}</p>
              <div class="item-price">${priceHtml}</div>
            </div>
            <button class="add-item-btn" onclick="openModifierModal('${item.id}', '${cat.id}')" style="align-self: center; margin-left: 8px;">+</button>
          </div>
        `;
        itemList.appendChild(itemCard);
      });

      catBlock.appendChild(itemList);
      container.appendChild(catBlock);
    });

  } catch (err) {
    console.error('Error loading menu:', err);
  }
}

window.openModifierModal = function(itemId, categoryId) {
  // Find item
  const cat = state.selectedMenu.find(c => c.id === categoryId);
  const item = cat.items.find(i => i.id === itemId);

  document.getElementById('modalItemName').innerText = item.name;
  document.getElementById('modalItemDescription').innerText = item.description || '';
  const activePrice = (item.discount_price_cents !== null && item.discount_price_cents !== undefined) ? item.discount_price_cents : item.base_price_cents;
  document.getElementById('modalItemPrice').innerText = `₹${(activePrice/100).toFixed(2)}`;

  // Populate Modifiers Form
  const form = document.getElementById('modifierForm');
  form.innerHTML = '';

  if (item.modifierGroups && item.modifierGroups.length > 0) {
    item.modifierGroups.forEach(group => {
      const groupBlock = document.createElement('div');
      groupBlock.style.marginBottom = '16px';
      groupBlock.innerHTML = `<div class="modifier-selection-title">${group.name}</div>`;
      
      group.modifiers.forEach(mod => {
        const modRow = document.createElement('div');
        modRow.className = 'modifier-checkbox-row';
        
        // Single selection (Radio) or multi select (checkbox)
        const isSingle = group.min_selection === 1 && group.max_selection === 1;
        const type = isSingle ? 'radio' : 'checkbox';
        
        modRow.innerHTML = `
          <label for="mod_${mod.id}">${mod.name} ${mod.price_cents > 0 ? `(+₹${(mod.price_cents/100).toFixed(2)})` : ''}</label>
          <input type="${type}" id="mod_${mod.id}" name="group_${group.id}" value="${mod.id}" data-price="${mod.price_cents}" data-name="${mod.name}">
        `;
        groupBlock.appendChild(modRow);
      });
      form.appendChild(groupBlock);
    });
  } else {
    form.innerHTML = '<p style="font-size: 12px; color: var(--text-muted);">No modifiers needed for this item.</p>';
  }

  // Update add-to-basket button reference handler
  const btn = document.getElementById('addToCartSubmitBtn');
  btn.onclick = (e) => {
    e.preventDefault();
    addItemToBasket(item);
  };

  document.getElementById('modifierModal').style.display = 'flex';
};

function addItemToBasket(item) {
  const form = document.getElementById('modifierForm');
  const checkedInputs = form.querySelectorAll('input:checked');
  
  const selectedModifiers = [];
  const selectedModifiersNames = [];
  let modifierCostCents = 0;

  checkedInputs.forEach(input => {
    selectedModifiers.push(input.value);
    selectedModifiersNames.push(input.getAttribute('data-name'));
    modifierCostCents += parseInt(input.getAttribute('data-price') || '0', 10);
  });

  const activePrice = (item.discount_price_cents !== null && item.discount_price_cents !== undefined) ? item.discount_price_cents : item.base_price_cents;
  const totalItemPriceCents = activePrice + modifierCostCents;

  state.cart.restaurantId = state.selectedRestaurant.restaurantId;
  state.cart.items.push({
    menuItemId: item.id,
    name: item.name,
    quantity: 1,
    basePriceCents: activePrice,
    selectedModifiers,
    selectedModifiersNames,
    totalItemPriceCents
  });

  document.getElementById('modifierModal').style.display = 'none';
  recalculateCart();
}

function recalculateCart() {
  const container = document.getElementById('cartItemsContainer');
  container.innerHTML = '';

  if (state.cart.items.length === 0) {
    container.innerHTML = '<p class="empty-message">Your basket is empty. Browse menus to add items.</p>';
    document.getElementById('cartSubtotal').innerText = '₹0.00';
    document.getElementById('cartDelivery').innerText = '₹0.00';
    document.getElementById('cartTax').innerText = '₹0.00';
    document.getElementById('cartTotal').innerText = '₹0.00';
    document.getElementById('checkoutBtn').disabled = true;
    return;
  }

  let subtotal = 0;
  state.cart.items.forEach((item, index) => {
    subtotal += item.totalItemPriceCents;

    const row = document.createElement('div');
    row.className = 'cart-item-row';
    
    const modsText = item.selectedModifiersNames.join(', ');
    row.innerHTML = `
      <div class="cart-item-desc">
        <h5>${item.name}</h5>
        ${modsText ? `<p>Modifiers: ${modsText}</p>` : ''}
        <button class="remove-cart-btn" onclick="removeFromCart(${index})">Remove</button>
      </div>
      <div class="cart-item-right">
        <span class="cart-item-qty">x${item.quantity}</span>
        <span class="cart-item-price">₹${(item.totalItemPriceCents/100).toFixed(2)}</span>
      </div>
    `;
    container.appendChild(row);
  });

  const fulfillmentSelect = document.getElementById('cartFulfillmentType');
  const fulfillmentType = fulfillmentSelect ? fulfillmentSelect.value : 'DELIVERY';
  const deliveryFee = (fulfillmentType === 'PICKUP') ? 0 : 350;
  const tax = Math.round(subtotal * 0.08);
  const total = subtotal + deliveryFee + tax;

  state.cart.subtotal = subtotal;
  state.cart.delivery = deliveryFee;
  state.cart.tax = tax;
  state.cart.total = total;

  document.getElementById('cartSubtotal').innerText = `₹${(subtotal/100).toFixed(2)}`;
  document.getElementById('cartDelivery').innerText = `₹${(deliveryFee/100).toFixed(2)}`;
  document.getElementById('cartTax').innerText = `₹${(tax/100).toFixed(2)}`;
  document.getElementById('cartTotal').innerText = `₹${(total/100).toFixed(2)}`;
  document.getElementById('checkoutBtn').disabled = false;
}

window.removeFromCart = function(index) {
  state.cart.items.splice(index, 1);
  recalculateCart();
};

function resetCart() {
  state.cart = {
    restaurantId: null,
    items: [],
    subtotal: 0,
    delivery: 0,
    tax: 0,
    total: 0
  };
  recalculateCart();
}

async function handleCartCheckout() {
  if (!state.consumerToken) {
    document.getElementById('consumerAuthModal').style.display = 'block';
    alert('Please sign in or create an account to place your order.');
    return;
  }

  const checkoutBtn = document.getElementById('checkoutBtn');
  const paymentMethod = document.getElementById('cartPaymentMethod').value;
  
  // Client-side payment inputs validation
  if (paymentMethod === 'CARD') {
    const cardNum = document.getElementById('payCardNum').value.trim();
    const expiry = document.getElementById('payCardExpiry').value.trim();
    const cvv = document.getElementById('payCardCVV').value.trim();
    if (!cardNum || !expiry || !cvv) {
      alert('Please fill out all Credit Card fields before checkout.');
      return;
    }
  } else if (paymentMethod === 'UPI') {
    const upiId = document.getElementById('payUpiId').value.trim();
    if (!upiId) {
      alert('Please enter a valid UPI ID (VPA) before checkout.');
      return;
    }
  }

  let authMessage = 'Authorizing split charge (Stripe)...';
  if (paymentMethod === 'UPI') authMessage = 'Generating UPI QR Transfer...';
  else if (paymentMethod === 'COD') authMessage = 'Booking Cash Delivery order...';

  checkoutBtn.disabled = true;
  checkoutBtn.innerText = authMessage;

  try {
    const fulfillmentSelect = document.getElementById('cartFulfillmentType');
    const fulfillmentType = fulfillmentSelect ? fulfillmentSelect.value : 'DELIVERY';

    const payload = {
      restaurantId: state.cart.restaurantId,
      items: state.cart.items,
      paymentMethod,
      fulfillmentType,
      // Default delivery details mock coordinates (NY Midtown)
      deliveryAddress: fulfillmentType === 'PICKUP' ? 'Self-Pickup at Outlet' : '15 Penn Plaza, New York, NY 10001',
      deliveryLat: 40.7500 + (Math.random() - 0.5) * 0.01,
      deliveryLng: -73.9900 + (Math.random() - 0.5) * 0.01
    };

    const response = await fetch('/api/storefront/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.token}`,
        'X-Tenant-ID': state.selectedRestaurant.tenantId
      },
      body: JSON.stringify(payload)
    });
    const data = await response.json();

    if (data.error) {
      alert(`Payment Processing error: ${data.error}`);
      checkoutBtn.disabled = false;
      if (paymentMethod === 'UPI') checkoutBtn.innerText = 'Place Order (UPI Transfer)';
      else if (paymentMethod === 'COD') checkoutBtn.innerText = 'Place Order (Cash on Delivery)';
      else checkoutBtn.innerText = 'Place Order (Mock Stripe Pay)';
      return;
    }

    // Enter active tracking view
    state.activeTrackingOrder = {
      orderId: data.orderId,
      status: 'PLACED',
      restLat: state.selectedRestaurant.latitude,
      restLng: state.selectedRestaurant.longitude,
      custLat: payload.deliveryLat,
      custLng: payload.deliveryLng,
      driverLat: null,
      driverLng: null,
      driverName: null,
      fulfillmentType: payload.fulfillmentType,
      pickupCode: data.pickupCode
    };

    // Open Tracking UI
    document.getElementById('storefrontMenuPanel').style.display = 'none';
    document.getElementById('shoppingCartPanel').style.display = 'none';
    
    const consumerGrid = document.querySelector('.consumer-grid');
    consumerGrid.classList.add('tracking-active');
    
    document.getElementById('orderTrackingPanel').style.display = 'block';
    
    document.getElementById('trackingOrderId').innerText = data.orderId;
    document.getElementById('trackingRestaurantLabel').innerText = `Restaurant: ${state.selectedRestaurant.name}`;
    document.getElementById('trackingDriverLabel').innerText = `Delivery Partner: Searching for nearby drivers...`;

    // Clear cart upon successful order placement
    resetCart();

    updateTrackingProgressSteps('PLACED');
    renderTrackingMap();

  } catch (err) {
    console.error('Checkout error:', err);
    checkoutBtn.disabled = false;
  }
}

function updateTrackingProgressSteps(status) {
  document.getElementById('trackingStatusBadge').innerText = status;

  const isPickup = state.activeTrackingOrder && state.activeTrackingOrder.fulfillmentType === 'PICKUP';
  const steps = ['PLACED', 'ACCEPTED', 'PREPARING', 'READY', 'DISPATCHED', 'DELIVERED'];
  const currentIdx = steps.indexOf(status);

  // Toggle DISPATCHED step visibility for pickup orders
  const dispatchedStep = document.getElementById('step-DISPATCHED');
  if (dispatchedStep) {
    dispatchedStep.style.display = isPickup ? 'none' : 'flex';
  }

  steps.forEach((step, idx) => {
    const element = document.getElementById(`step-${step}`);
    if (!element) return;
    if (idx < currentIdx) {
      element.className = 'progress-step completed';
    } else if (idx === currentIdx) {
      element.className = 'progress-step active';
    } else {
      element.className = 'progress-step';
    }
  });

  // Dynamically display pickup pass code card to the consumer
  const passContainerId = 'trackingPickupPassCodeContainer';
  let passContainer = document.getElementById(passContainerId);
  if (!passContainer) {
    const trackingCard = document.getElementById('orderTrackingPanel');
    if (trackingCard) {
      passContainer = document.createElement('div');
      passContainer.id = passContainerId;
      passContainer.style.marginTop = '15px';
      passContainer.style.padding = '12px';
      passContainer.style.background = 'rgba(245, 158, 11, 0.1)';
      passContainer.style.border = '1px solid var(--accent-amber)';
      passContainer.style.borderRadius = '6px';
      passContainer.style.textAlign = 'center';
      
      const label = document.getElementById('trackingDriverLabel');
      if (label && label.parentNode) {
        label.parentNode.insertBefore(passContainer, label.nextSibling);
      }
    }
  }

  if (passContainer) {
    if (isPickup) {
      passContainer.style.display = 'block';
      const code = state.activeTrackingOrder.pickupCode || 'Generating...';
      passContainer.innerHTML = `
        <span style="display: block; font-size: 11px; text-transform: uppercase; color: var(--text-secondary); font-weight: 600;">Self-Pickup Pass Code</span>
        <strong style="display: block; font-size: 24px; color: var(--accent-green); margin: 6px 0; letter-spacing: 2px;">${code}</strong>
        <span style="display: block; font-size: 12px; color: var(--text-main);">Present this code at the counter to verify your pickup.</span>
      `;
      document.getElementById('trackingDriverLabel').innerText = 'Fulfillment Mode: Self-Pickup';
    } else {
      passContainer.style.display = 'none';
    }
  }
}

function renderTrackingMap() {
  if (!state.activeTrackingOrder) return;
  const o = state.activeTrackingOrder;

  // Clear canvas
  mapCtx.fillStyle = '#121926';
  mapCtx.fillRect(0, 0, mapCanvas.width, mapCanvas.height);

  // Map scale calculations (Fit Restaurant, Customer, and Driver)
  // Since coordinates are New York (Lat 40.7, Lng -74), we normalize them for canvas
  const padding = 40;
  const coordinates = [
    { lat: o.restLat, lng: o.restLng },
    { lat: o.custLat, lng: o.custLng }
  ];
  if (o.driverLat && o.driverLng) {
    coordinates.push({ lat: o.driverLat, lng: o.driverLng });
  }

  const lats = coordinates.map(c => c.lat);
  const lngs = coordinates.map(c => c.lng);

  const minLat = Math.min(...lats) - 0.005;
  const maxLat = Math.max(...lats) + 0.005;
  const minLng = Math.min(...lngs) - 0.005;
  const maxLng = Math.max(...lngs) + 0.005;

  const latRange = maxLat - minLat;
  const lngRange = maxLng - minLng;

  const getCanvasCoords = (lat, lng) => {
    const x = padding + ((lng - minLng) / lngRange) * (mapCanvas.width - 2 * padding);
    // Y is inverted on canvas
    const y = mapCanvas.height - padding - ((lat - minLat) / latRange) * (mapCanvas.height - 2 * padding);
    return { x, y };
  };

  // Draw grid helper lines
  mapCtx.strokeStyle = 'rgba(51, 65, 85, 0.3)';
  mapCtx.lineWidth = 1;
  for (let i = 1; i < 6; i++) {
    const x = (mapCanvas.width / 6) * i;
    mapCtx.beginPath();
    mapCtx.moveTo(x, 0);
    mapCtx.lineTo(x, mapCanvas.height);
    mapCtx.stroke();

    const y = (mapCanvas.height / 6) * i;
    mapCtx.beginPath();
    mapCtx.moveTo(0, y);
    mapCtx.lineTo(mapCanvas.width, y);
    mapCtx.stroke();
  }

  const restPt = getCanvasCoords(o.restLat, o.restLng);
  const custPt = getCanvasCoords(o.custLat, o.custLng);

  // Draw delivery path line
  mapCtx.strokeStyle = 'rgba(59, 130, 246, 0.4)';
  mapCtx.lineWidth = 2;
  mapCtx.setLineDash([5, 5]);
  mapCtx.beginPath();
  mapCtx.moveTo(restPt.x, restPt.y);
  mapCtx.lineTo(custPt.x, custPt.y);
  mapCtx.stroke();
  mapCtx.setLineDash([]); // Reset line dash

  // Draw Restaurant (Red Dot)
  mapCtx.fillStyle = '#ef4444';
  mapCtx.beginPath();
  mapCtx.arc(restPt.x, restPt.y, 8, 0, 2 * Math.PI);
  mapCtx.fill();
  mapCtx.fillStyle = '#fff';
  mapCtx.font = '10px sans-serif';
  mapCtx.fillText('🍴 Store', restPt.x + 12, restPt.y + 4);

  // Draw Customer (Blue Dot)
  mapCtx.fillStyle = '#3b82f6';
  mapCtx.beginPath();
  mapCtx.arc(custPt.x, custPt.y, 8, 0, 2 * Math.PI);
  mapCtx.fill();
  mapCtx.fillStyle = '#fff';
  mapCtx.fillText('🏠 Home', custPt.x + 12, custPt.y + 4);

  // Draw Driver (Green Dot)
  if (o.driverLat && o.driverLng) {
    const driverPt = getCanvasCoords(o.driverLat, o.driverLng);
    mapCtx.fillStyle = '#10b981';
    mapCtx.beginPath();
    mapCtx.arc(driverPt.x, driverPt.y, 6, 0, 2 * Math.PI);
    mapCtx.fill();
    mapCtx.fillStyle = '#fff';
    mapCtx.fillText('🛵 Driver', driverPt.x + 10, driverPt.y + 4);
  }
}

// ==========================================
// DRIVER CLIENT LOGISTICS
// ==========================================

async function refreshDriverDashboard() {
  // Clear any existing simulation intervals
  if (state.tripSimulationInterval) {
    clearInterval(state.tripSimulationInterval);
  }

  try {
    const response = await fetch('/api/driver/deliveries', {
      headers: {
        'Authorization': `Bearer ${state.token}`
      }
    });
    const deliveries = await response.json();
    
    // Look for an in-progress delivery
    const activeDel = (deliveries && Array.isArray(deliveries)) ? deliveries.find(d => d.order_status !== 'DELIVERED') : null;
    
    if (activeDel) {
      state.driverStatus = 'DELIVERING';
      
      state.activeTrip = {
        tenantId: activeDel.tenantId,
        orderId: activeDel.order_id,
        restLat: activeDel.rest_lat,
        restLng: activeDel.rest_lng,
        destLat: activeDel.delivery_lat,
        destLng: activeDel.delivery_lng,
        status: activeDel.order_status
      };

      document.getElementById('tripRestaurant').innerText = activeDel.restaurant_name;
      document.getElementById('tripDestination').innerText = activeDel.delivery_address;
      document.getElementById('tripJobStatus').innerText = activeDel.order_status;
      document.getElementById('tripJobStatus').className = `badge ${activeDel.order_status.toLowerCase()}`;

      document.getElementById('driverOfferPanel').style.display = 'none';
      document.getElementById('driverActiveTripPanel').style.display = 'block';

      // Setup actions based on current order status
      document.getElementById('simulatePickupBtn').style.display = (activeDel.order_status === 'ACCEPTED' || activeDel.order_status === 'PREPARING' || activeDel.order_status === 'READY') ? 'block' : 'none';
      document.getElementById('markPickedUpBtn').style.display = 'none';
      document.getElementById('simulateDeliveryBtn').style.display = activeDel.order_status === 'DISPATCHED' ? 'block' : 'none';
      document.getElementById('markDeliveredBtn').style.display = 'none';
    } else {
      // If they were delivering but it's done or unassigned
      if (state.driverStatus === 'DELIVERING') {
        state.driverStatus = 'ONLINE';
      }
      document.getElementById('driverOfferPanel').style.display = 'block';
      document.getElementById('driverActiveTripPanel').style.display = 'none';
    }
  } catch (err) {
    console.error('Error refreshing driver deliveries:', err);
    document.getElementById('driverOfferPanel').style.display = 'block';
    document.getElementById('driverActiveTripPanel').style.display = 'none';
  }

  updateDriverUIState();
}

function updateDriverUIState() {
  const label = document.getElementById('driverStatusLabel');
  const dot = document.getElementById('driverStatusDot');
  const btn = document.getElementById('driverToggleOnlineBtn');

  document.getElementById('driverLat').innerText = state.driverLocation.lat.toFixed(6);
  document.getElementById('driverLng').innerText = state.driverLocation.lng.toFixed(6);

  if (state.driverStatus === 'ONLINE') {
    label.innerText = 'ONLINE (Idle)';
    dot.className = 'status-dot green';
    btn.innerText = 'Go Offline';
    btn.className = 'primary-btn red-btn';
  } else if (state.driverStatus === 'DELIVERING') {
    label.innerText = 'ACTIVE (Delivering)';
    dot.className = 'status-dot amber';
    btn.innerText = 'End Active Trip';
    btn.className = 'primary-btn red-btn';
    btn.disabled = true; // Cannot go offline during delivery
  } else {
    label.innerText = 'OFFLINE';
    dot.className = 'status-dot red';
    btn.innerText = 'Go Online';
    btn.className = 'primary-btn green-btn';
    btn.disabled = false;
  }
}

function handleDriverOnlineToggle() {
  if (state.driverStatus === 'OFFLINE') {
    state.driverStatus = 'ONLINE';
    // Send location sync message to server
    if (state.socket && state.socket.readyState === WebSocket.OPEN) {
      state.socket.send(JSON.stringify({
        action: 'update_location',
        data: {
          lat: state.driverLocation.lat,
          lng: state.driverLocation.lng,
          status: 'ONLINE'
        }
      }));
    }
  } else {
    state.driverStatus = 'OFFLINE';
    if (state.socket && state.socket.readyState === WebSocket.OPEN) {
      state.socket.send(JSON.stringify({
        action: 'update_location',
        data: {
          lat: state.driverLocation.lat,
          lng: state.driverLocation.lng,
          status: 'OFFLINE'
        }
      }));
    }
  }
  updateDriverUIState();
}

function showDriverOfferAlert(offer) {
  state.activeOffer = offer;
  
  document.getElementById('offerStoreName').innerText = offer.restaurantName;
  document.getElementById('offerPickupAddress').innerText = offer.restaurantAddress;
  document.getElementById('offerDeliveryAddress').innerText = offer.deliveryAddress;
  
  document.getElementById('noOfferMessage').style.display = 'none';
  document.getElementById('activeOfferCard').style.display = 'block';

  // 30s countdown timer
  let countdown = 30;
  const countBadge = document.getElementById('offerCountdown');
  countBadge.innerText = `${countdown}s`;

  const interval = setInterval(() => {
    countdown--;
    countBadge.innerText = `${countdown}s`;
    if (countdown <= 0) {
      clearInterval(interval);
      dismissOfferCard();
    }
  }, 1000);

  // Store countdown interval to clear later
  state.activeOffer.countdownInterval = interval;
}

function dismissOfferCard() {
  document.getElementById('activeOfferCard').style.display = 'none';
  document.getElementById('noOfferMessage').style.display = 'block';
  if (state.activeOffer && state.activeOffer.countdownInterval) {
    clearInterval(state.activeOffer.countdownInterval);
  }
  state.activeOffer = null;
}

async function handleOfferResponse(action) {
  if (!state.activeOffer) return;
  const { tenantId, orderId } = state.activeOffer;

  // Clear timer
  clearInterval(state.activeOffer.countdownInterval);

  try {
    const response = await fetch(`/api/driver/deliveries/${tenantId}/${orderId}/respond`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.token}`
      },
      body: JSON.stringify({ action })
    });
    const data = await response.json();

    if (data.error) {
      alert(data.error);
      dismissOfferCard();
      return;
    }

    if (action === 'ACCEPT') {
      state.driverStatus = 'DELIVERING';
      updateDriverUIState();
      
      // Load active trip management
      state.activeTrip = {
        tenantId,
        orderId,
        restLat: state.activeOffer.restaurantLat,
        restLng: state.activeOffer.restaurantLng,
        destLat: state.activeOffer.deliveryLat,
        destLng: state.activeOffer.deliveryLng,
        status: 'ACCEPTED'
      };

      document.getElementById('tripRestaurant').innerText = state.activeOffer.restaurantName;
      document.getElementById('tripDestination').innerText = state.activeOffer.deliveryAddress;
      document.getElementById('tripJobStatus').innerText = 'ACCEPTED';
      document.getElementById('tripJobStatus').className = 'badge accepted';

      document.getElementById('driverOfferPanel').style.display = 'none';
      document.getElementById('driverActiveTripPanel').style.display = 'block';

      // Setup actions
      document.getElementById('simulatePickupBtn').style.display = 'block';
      document.getElementById('markPickedUpBtn').style.display = 'none';
      document.getElementById('simulateDeliveryBtn').style.display = 'none';
      document.getElementById('markDeliveredBtn').style.display = 'none';

    }
    
    dismissOfferCard();

  } catch (err) {
    console.error(err);
    dismissOfferCard();
  }
}

// ==========================================
// SIMULATED GPS DRIVING LOOPS
// ==========================================

function startSimulationToRestaurant() {
  const trip = state.activeTrip;
  document.getElementById('simulatePickupBtn').disabled = true;

  // Simulate movement coordinates incrementing from current position to restaurant branch location
  let steps = 0;
  const totalSteps = 20;

  const startLat = state.driverLocation.lat;
  const startLng = state.driverLocation.lng;
  const endLat = trip.restLat;
  const endLng = trip.restLng;

  state.tripSimulationInterval = setInterval(() => {
    steps++;
    const fraction = steps / totalSteps;
    
    const lat = startLat + (endLat - startLat) * fraction;
    const lng = startLng + (endLng - startLng) * fraction;

    state.driverLocation.lat = lat;
    state.driverLocation.lng = lng;

    // Send update over WS
    state.socket.send(JSON.stringify({
      action: 'update_location',
      data: { lat, lng }
    }));

    document.getElementById('driverLat').innerText = lat.toFixed(6);
    document.getElementById('driverLng').innerText = lng.toFixed(6);

    if (steps >= totalSteps) {
      clearInterval(state.tripSimulationInterval);
      document.getElementById('simulatePickupBtn').style.display = 'none';
      document.getElementById('markPickedUpBtn').style.display = 'block';
      alert('You have arrived at the restaurant. Collect the food package.');
    }
  }, 400); // 400ms steps
}

async function markOrderPickedUp() {
  const trip = state.activeTrip;
  try {
    const response = await fetch(`/api/tenant/orders/${trip.orderId}/transition`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.token}`,
        'X-Tenant-ID': trip.tenantId
      },
      body: JSON.stringify({ targetStatus: 'DISPATCHED' })
    });
    const data = await response.json();

    if (data.error) {
       alert(data.error);
       return;
    }

    state.activeTrip.status = 'DISPATCHED';
    document.getElementById('tripJobStatus').innerText = 'DISPATCHED';
    document.getElementById('tripJobStatus').className = 'badge dispatched';

    document.getElementById('markPickedUpBtn').style.display = 'none';
    document.getElementById('simulateDeliveryBtn').style.display = 'block';

  } catch (err) {
    console.error(err);
  }
}

function startSimulationToCustomer() {
  const trip = state.activeTrip;
  document.getElementById('simulateDeliveryBtn').disabled = true;

  let steps = 0;
  const totalSteps = 20;

  const startLat = state.driverLocation.lat;
  const startLng = state.driverLocation.lng;
  const endLat = trip.destLat;
  const endLng = trip.destLng;

  state.tripSimulationInterval = setInterval(() => {
    steps++;
    const fraction = steps / totalSteps;
    
    const lat = startLat + (endLat - startLat) * fraction;
    const lng = startLng + (endLng - startLng) * fraction;

    state.driverLocation.lat = lat;
    state.driverLocation.lng = lng;

    // Send update over WS
    state.socket.send(JSON.stringify({
      action: 'update_location',
      data: { lat, lng }
    }));

    document.getElementById('driverLat').innerText = lat.toFixed(6);
    document.getElementById('driverLng').innerText = lng.toFixed(6);

    if (steps >= totalSteps) {
      clearInterval(state.tripSimulationInterval);
      document.getElementById('simulateDeliveryBtn').style.display = 'none';
      document.getElementById('markDeliveredBtn').style.display = 'block';
      alert('Arrived at customer address. Ring the doorbell.');
    }
  }, 400);
}

async function markOrderDelivered() {
  const trip = state.activeTrip;
  try {
    const response = await fetch(`/api/tenant/orders/${trip.orderId}/transition`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.token}`,
        'X-Tenant-ID': trip.tenantId
      },
      body: JSON.stringify({ targetStatus: 'DELIVERED' })
    });
    const data = await response.json();

    if (data.error) {
       alert(data.error);
       return;
    }

    alert('Fulfillment complete! Payment split has been deposited to your connected wallet.');
    
    // Free Driver status
    state.driverStatus = 'ONLINE';
    // Update location back to online
    state.socket.send(JSON.stringify({
      action: 'update_location',
      data: { lat: state.driverLocation.lat, lng: state.driverLocation.lng, status: 'ONLINE' }
    }));

    refreshDriverDashboard();

  } catch (err) {
    console.error(err);
  }
}

// ==========================================
// INTERACTIVE CONSUMER LOGIN & REGISTER HANDLERS
// ==========================================

async function handleConsumerLoginSubmit(e) {
  e.preventDefault();
  const email = document.getElementById('consumerLoginEmail').value.trim();
  const password = document.getElementById('consumerLoginPassword').value.trim();
  const statusDiv = document.getElementById('consumerAuthStatusMessage');

  statusDiv.className = 'status-message';
  statusDiv.style.color = 'var(--text-secondary)';
  statusDiv.innerText = 'Signing in...';

  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, tenantId: state.activeTenantId })
    });
    const data = await response.json();

    if (data.error) {
      statusDiv.className = 'status-message error-message';
      statusDiv.style.color = 'var(--accent-red)';
      statusDiv.innerText = `Error: ${data.error}`;
      return;
    }

    // Automatically switch roles and panels based on authenticated user's role
    if (data.user.role === 'TENANT_ADMIN') {
      state.tenantToken = data.token;
      state.tenantUser = data.user;
      localStorage.setItem('tenantToken', data.token);
      localStorage.setItem('tenantUser', JSON.stringify(data.user));
      
      document.getElementById('consumerAuthModal').style.display = 'none';
      document.getElementById('consumerLoginForm').reset();
      statusDiv.innerText = '';
      
      history.pushState(null, '', '/tenant-admin');
      loginAndSwitchRole('TENANT_ADMIN');
      return;
    }

    if (data.user.role === 'DRIVER') {
      state.driverToken = data.token;
      state.driverUser = data.user;
      localStorage.setItem('driverToken', data.token);
      localStorage.setItem('driverUser', JSON.stringify(data.user));
      
      document.getElementById('consumerAuthModal').style.display = 'none';
      document.getElementById('consumerLoginForm').reset();
      statusDiv.innerText = '';
      
      history.pushState(null, '', '/driver');
      loginAndSwitchRole('DRIVER');
      return;
    }

    if (data.user.role === 'PLATFORM_ADMIN') {
      const subdomain = getSubdomain();
      if (subdomain) {
        statusDiv.style.color = 'var(--accent-red)';
        statusDiv.innerText = 'Platform Admin must log in via the main domain (localhost:3000).';
        return;
      }
      state.platformAdminToken = data.token;
      state.platformAdminUser = data.user;
      localStorage.setItem('platformAdminToken', data.token);
      localStorage.setItem('platformAdminUser', JSON.stringify(data.user));
      
      document.getElementById('consumerAuthModal').style.display = 'none';
      document.getElementById('consumerLoginForm').reset();
      statusDiv.innerText = '';
      
      history.pushState(null, '', '/platform-admin');
      loginAndSwitchRole('PLATFORM_ADMIN');
      return;
    }

    // Default: Set consumer session state
    state.consumerToken = data.token;
    state.consumerUser = data.user;
    localStorage.setItem('consumerToken', data.token);
    localStorage.setItem('consumerUser', JSON.stringify(data.user));

    // Hide Auth Modal
    document.getElementById('consumerAuthModal').style.display = 'none';

    // Clear form
    document.getElementById('consumerLoginForm').reset();
    statusDiv.innerText = '';

    // Switch View to Consumer Main Dashboard
    loginAndSwitchRole('CONSUMER');

  } catch (err) {
    statusDiv.className = 'status-message error-message';
    statusDiv.style.color = 'var(--accent-red)';
    statusDiv.innerText = `Auth exception: ${err.message}`;
  }
}

async function handleConsumerRegisterSubmit(e) {
  e.preventDefault();
  const email = document.getElementById('consumerRegEmail').value.trim();
  const password = document.getElementById('consumerRegPassword').value.trim();
  const firstName = document.getElementById('consumerRegFirstName').value.trim();
  const lastName = document.getElementById('consumerRegLastName').value.trim();
  const phone = document.getElementById('consumerRegPhone').value.trim();
  const address = document.getElementById('consumerRegAddress').value.trim();
  const statusDiv = document.getElementById('consumerAuthStatusMessage');

  statusDiv.className = 'status-message';
  statusDiv.style.color = 'var(--text-secondary)';
  statusDiv.innerText = 'Creating account...';

  try {
    const response = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, firstName, lastName, phone, address, tenantId: state.activeTenantId })
    });
    const data = await response.json();

    if (data.error) {
      statusDiv.className = 'status-message error-message';
      statusDiv.style.color = 'var(--accent-red)';
      statusDiv.innerText = `Registration Error: ${data.error}`;
      return;
    }

    // Set consumer session state (auto login)
    state.consumerToken = data.token;
    state.consumerUser = data.user;
    localStorage.setItem('consumerToken', data.token);
    localStorage.setItem('consumerUser', JSON.stringify(data.user));

    // Hide Auth Modal
    document.getElementById('consumerAuthModal').style.display = 'none';

    // Clear form
    document.getElementById('consumerRegisterForm').reset();
    statusDiv.innerText = '';

    // Switch View to Consumer Main Dashboard
    loginAndSwitchRole('CONSUMER');

  } catch (err) {
    statusDiv.className = 'status-message error-message';
    statusDiv.style.color = 'var(--accent-red)';
    statusDiv.innerText = `Registration exception: ${err.message}`;
  }
}

async function handleDriverLoginSubmit(e) {
  e.preventDefault();
  const email = document.getElementById('driverLoginEmail').value.trim();
  const password = document.getElementById('driverLoginPassword').value.trim();
  const statusDiv = document.getElementById('driverAuthStatusMessage');

  statusDiv.style.color = 'var(--text-secondary)';
  statusDiv.innerText = 'Signing in...';

  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, tenantId: state.activeTenantId })
    });
    const data = await response.json();

    if (data.error) {
      statusDiv.style.color = 'var(--accent-red)';
      statusDiv.innerText = `Login failed: ${data.error}`;
      return;
    }

    if (data.user.role !== 'DRIVER') {
      statusDiv.style.color = 'var(--accent-red)';
      statusDiv.innerText = 'Access Denied: Requiring Driver role credentials.';
      return;
    }

    // Capture and save driver session
    state.driverToken = data.token;
    state.driverUser = data.user;
    localStorage.setItem('driverToken', data.token);
    localStorage.setItem('driverUser', JSON.stringify(data.user));

    // Clear form
    document.getElementById('driverLoginForm').reset();
    statusDiv.innerText = '';

    // Switch View
    loginAndSwitchRole('DRIVER');

  } catch (err) {
    console.error(err);
    statusDiv.style.color = 'var(--accent-red)';
    statusDiv.innerText = 'System error occurred.';
  }
}

async function handleDriverRegisterSubmit(e) {
  e.preventDefault();
  const email = document.getElementById('driverRegEmail').value.trim();
  const password = document.getElementById('driverRegPassword').value.trim();
  const firstName = document.getElementById('driverRegFirstName').value.trim();
  const lastName = document.getElementById('driverRegLastName').value.trim();
  const phone = document.getElementById('driverRegPhone').value.trim();
  const statusDiv = document.getElementById('driverAuthStatusMessage');

  statusDiv.style.color = 'var(--text-secondary)';
  statusDiv.innerText = 'Registering partner account...';

  try {
    const response = await fetch('/api/auth/register-driver', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, firstName, lastName, phone, tenantId: state.activeTenantId })
    });
    const data = await response.json();

    if (data.error) {
      statusDiv.style.color = 'var(--accent-red)';
      statusDiv.innerText = `Registration failed: ${data.error}`;
      return;
    }

    // Auto login registered driver
    state.driverToken = data.token;
    state.driverUser = data.user;
    localStorage.setItem('driverToken', data.token);
    localStorage.setItem('driverUser', JSON.stringify(data.user));

    // Clear form
    document.getElementById('driverRegisterForm').reset();
    statusDiv.innerText = '';

    // Switch View
    loginAndSwitchRole('DRIVER');

  } catch (err) {
    console.error(err);
    statusDiv.style.color = 'var(--accent-red)';
    statusDiv.innerText = 'System error occurred.';
  }
}

// ==========================================
// TENANT ADMIN DISH CRUD ACTION HANDLERS
// ==========================================

async function loadCategoryDropdownOptions(selectedId = null) {
  const dropdown = document.getElementById('dishFormCategory');
  dropdown.innerHTML = '';

  try {
    const response = await fetch('/api/tenant/menu/categories', {
      headers: {
        'Authorization': `Bearer ${state.token}`,
        'X-Tenant-ID': state.activeTenantId
      }
    });
    const categories = await response.json();
    
    categories.forEach(cat => {
      const option = document.createElement('option');
      option.value = cat.id;
      option.text = cat.name;
      if (cat.id === selectedId) option.selected = true;
      dropdown.appendChild(option);
    });
  } catch (e) {
    console.error('Failed to load categories dropdown:', e);
  }
}

async function openAddDishModal() {
  document.getElementById('dishModalTitle').innerText = 'Add New Dish';
  document.getElementById('dishFormId').value = '';
  document.getElementById('dishForm').reset();
  
  document.getElementById('deleteDishSubmitBtn').style.display = 'none';
  document.getElementById('dishFormStatusMessage').innerText = '';

  // Reset file uploader inputs & status
  document.getElementById('dishFormPhotoFile').value = '';
  document.getElementById('dishFormImageUrl').value = '';
  state.editingDishImages = [];
  renderDishFormImages();

  await loadCategoryDropdownOptions();
  document.getElementById('dishModal').style.display = 'flex';
}

window.openEditDishModal = async function(categoryId, itemId) {
  document.getElementById('dishModalTitle').innerText = 'Edit Dish Info';
  document.getElementById('dishFormId').value = itemId;
  document.getElementById('deleteDishSubmitBtn').style.display = 'block';
  document.getElementById('dishFormStatusMessage').innerText = '';

  // Find item details from our local state cache
  const cat = state.tenantMenu.find(c => c.id === categoryId);
  const item = cat.items.find(i => i.id === itemId);

  // Pre-fill inputs
  document.getElementById('dishFormName').value = item.name;
  document.getElementById('dishFormDescription').value = item.description || '';
  document.getElementById('dishFormBasePrice').value = (item.base_price_cents / 100).toFixed(2);
  document.getElementById('dishFormDiscountPrice').value = item.discount_price_cents ? (item.discount_price_cents / 100).toFixed(2) : '';
  document.getElementById('dishFormDietary').value = item.dietary_tag || '';
  document.getElementById('dishFormAvailable').checked = item.is_available === 1;
  document.getElementById('dishFormImageUrl').value = item.image_url || '';
  document.getElementById('dishFormPhotoFile').value = '';
  
  // Load existing multiple images from the database
  try {
    state.editingDishImages = item.images ? JSON.parse(item.images) : (item.image_url ? [item.image_url] : []);
  } catch (e) {
    state.editingDishImages = item.image_url ? [item.image_url] : [];
  }
  renderDishFormImages();

  await loadCategoryDropdownOptions(categoryId);
  document.getElementById('dishModal').style.display = 'flex';
};

async function handleDishFormSubmit() {
  const itemId = document.getElementById('dishFormId').value;
  const categoryId = document.getElementById('dishFormCategory').value;
  const name = document.getElementById('dishFormName').value.trim();
  const description = document.getElementById('dishFormDescription').value.trim();
  const basePrice = document.getElementById('dishFormBasePrice').value;
  const discountPrice = document.getElementById('dishFormDiscountPrice').value;
  const dietaryTag = document.getElementById('dishFormDietary').value;
  const isAvailable = document.getElementById('dishFormAvailable').checked;
  const imageUrl = document.getElementById('dishFormImageUrl').value.trim();
  const statusDiv = document.getElementById('dishFormStatusMessage');

  if (!categoryId || !name || !basePrice) {
    statusDiv.style.color = 'var(--accent-red)';
    statusDiv.innerText = 'Please fill out all required fields.';
    return;
  }

  // Convert prices to cents
  const basePriceCents = Math.round(parseFloat(basePrice) * 100);
  const discountPriceCents = discountPrice ? Math.round(parseFloat(discountPrice) * 100) : null;

  if (discountPriceCents && discountPriceCents >= basePriceCents) {
    statusDiv.style.color = 'var(--accent-red)';
    statusDiv.innerText = 'Discount price must be less than base price.';
    return;
  }

  statusDiv.style.color = 'var(--text-secondary)';
  statusDiv.innerText = 'Saving...';

  const payload = {
    categoryId,
    name,
    description,
    basePriceCents,
    discountPriceCents,
    dietaryTag,
    isAvailable,
    images: state.editingDishImages
  };

  const isEdit = itemId !== '';
  const url = isEdit ? `/api/tenant/menu/items/${itemId}` : '/api/tenant/menu/items';
  const method = isEdit ? 'PUT' : 'POST';

  try {
    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.token}`,
        'X-Tenant-ID': state.activeTenantId
      },
      body: JSON.stringify(payload)
    });
    const data = await response.json();

    if (data.error) {
      statusDiv.style.color = 'var(--accent-red)';
      statusDiv.innerText = `Save error: ${data.error}`;
      return;
    }

    // Success
    document.getElementById('dishModal').style.display = 'none';
    refreshTenantDashboard();
  } catch (err) {
    statusDiv.style.color = 'var(--accent-red)';
    statusDiv.innerText = `Save exception: ${err.message}`;
  }
}

async function handleDishPhotoUpload() {
  const fileInput = document.getElementById('dishFormPhotoFile');
  const uploadBtn = document.getElementById('uploadPhotoBtn');
  const statusLabel = document.getElementById('dishPhotoUploadStatus');

  if (!fileInput.files || fileInput.files.length === 0) {
    alert('Please select an image file first.');
    return;
  }

  const file = fileInput.files[0];
  const formData = new FormData();
  formData.append('photo', file);

  uploadBtn.disabled = true;
  statusLabel.innerText = 'Uploading photo...';
  statusLabel.style.color = 'var(--text-secondary)';

  try {
    const response = await fetch('/api/tenant/menu/items/upload', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${state.token}`,
        'X-Tenant-ID': state.activeTenantId
      },
      body: formData
    });
    const data = await response.json();

    if (data.error) {
      statusLabel.innerText = `Upload failed: ${data.error}`;
      statusLabel.style.color = 'var(--accent-red)';
      uploadBtn.disabled = false;
      return;
    }

    // Save image URL to state array
    state.editingDishImages.push(data.imageUrl);
    renderDishFormImages();
    uploadBtn.disabled = false;

  } catch (err) {
    statusLabel.innerText = `Upload error: ${err.message}`;
    statusLabel.style.color = 'var(--accent-red)';
    uploadBtn.disabled = false;
  }
}

async function handleDeleteDishSubmit(e) {
  e.preventDefault();
  const itemId = document.getElementById('dishFormId').value;
  if (!itemId) return;

  if (!confirm('Are you sure you want to delete this menu item permanently?')) return;

  const statusDiv = document.getElementById('dishFormStatusMessage');
  statusDiv.style.color = 'var(--text-secondary)';
  statusDiv.innerText = 'Deleting...';

  try {
    const response = await fetch(`/api/tenant/menu/items/${itemId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${state.token}`,
        'X-Tenant-ID': state.activeTenantId
      }
    });
    const data = await response.json();

    if (data.error) {
      statusDiv.style.color = 'var(--accent-red)';
      statusDiv.innerText = `Delete error: ${data.error}`;
      return;
    }

    // Success
    document.getElementById('dishModal').style.display = 'none';
    refreshTenantDashboard();
  } catch (err) {
    statusDiv.style.color = 'var(--accent-red)';
    statusDiv.innerText = `Delete exception: ${err.message}`;
  }
}

// ==========================================
// PLATFORM ADMIN TENANT CRUD ACTION HANDLERS
// ==========================================

window.openTenantEditModal = function(tenantId) {
  const tenant = state.tenants.find(t => t.id === tenantId);
  if (!tenant) return;

  document.getElementById('editTenantId').value = tenant.id;
  document.getElementById('editTenantName').value = tenant.business_name;
  document.getElementById('editTenantDomain').value = tenant.domain;
  document.getElementById('editTenantEmail').value = tenant.email || '';
  document.getElementById('editTenantPhone').value = tenant.phone || '';
  document.getElementById('editTenantAddress').value = tenant.address || '';
  document.getElementById('editTenantLat').value = tenant.latitude !== null ? tenant.latitude : '';
  document.getElementById('editTenantLng').value = tenant.longitude !== null ? tenant.longitude : '';
  document.getElementById('editTenantTier').value = tenant.subscription_tier;
  document.getElementById('editTenantStatus').value = tenant.status;
  document.getElementById('tenantEditStatusMessage').innerText = '';

  document.getElementById('tenantEditModal').style.display = 'flex';
};

async function handleTenantEditFormSubmit() {
  const id = document.getElementById('editTenantId').value;
  const businessName = document.getElementById('editTenantName').value.trim();
  const domain = document.getElementById('editTenantDomain').value.trim();
  const email = document.getElementById('editTenantEmail').value.trim();
  const phone = document.getElementById('editTenantPhone').value.trim();
  const address = document.getElementById('editTenantAddress').value.trim();
  const latitude = parseFloat(document.getElementById('editTenantLat').value);
  const longitude = parseFloat(document.getElementById('editTenantLng').value);
  const subscriptionTier = document.getElementById('editTenantTier').value;
  const status = document.getElementById('editTenantStatus').value;
  const statusDiv = document.getElementById('tenantEditStatusMessage');

  if (!businessName || !domain || !subscriptionTier || !status || !email || !phone || !address || isNaN(latitude) || isNaN(longitude)) {
    statusDiv.style.color = 'var(--accent-red)';
    statusDiv.innerText = 'All fields are required.';
    return;
  }

  statusDiv.style.color = 'var(--text-secondary)';
  statusDiv.innerText = 'Saving...';

  const payload = { businessName, domain, subscriptionTier, status, email, phone, address, latitude, longitude };

  try {
    const response = await fetch(`/api/admin/tenants/${id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.token}`
      },
      body: JSON.stringify(payload)
    });
    const data = await response.json();

    if (data.error) {
      statusDiv.style.color = 'var(--accent-red)';
      statusDiv.innerText = `Save error: ${data.error}`;
      return;
    }

    // Success
    document.getElementById('tenantEditModal').style.display = 'none';
    refreshPlatformAdminDashboard();
  } catch (err) {
    statusDiv.style.color = 'var(--accent-red)';
    statusDiv.innerText = `Save exception: ${err.message}`;
  }
}

async function handlePlatformLoginSubmit(e) {
  e.preventDefault();
  const email = document.getElementById('platformLoginEmail').value.trim();
  const password = document.getElementById('platformLoginPassword').value.trim();
  const statusDiv = document.getElementById('platformAuthStatusMessage');

  statusDiv.style.color = 'var(--text-secondary)';
  statusDiv.innerText = 'Signing in...';

  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await response.json();

    if (data.error) {
      statusDiv.style.color = 'var(--accent-red)';
      statusDiv.innerText = `Login failed: ${data.error}`;
      return;
    }

    if (data.user.role !== 'PLATFORM_ADMIN') {
      statusDiv.style.color = 'var(--accent-red)';
      statusDiv.innerText = 'Access Denied: Requiring Platform Admin role credentials.';
      return;
    }

    // Capture and save platform admin session
    state.platformAdminToken = data.token;
    state.platformAdminUser = data.user;
    localStorage.setItem('platformAdminToken', data.token);
    localStorage.setItem('platformAdminUser', JSON.stringify(data.user));

    // Clear form
    document.getElementById('platformLoginForm').reset();
    statusDiv.innerText = '';

    // Switch View
    loginAndSwitchRole('PLATFORM_ADMIN');

  } catch (err) {
    console.error(err);
    statusDiv.style.color = 'var(--accent-red)';
    statusDiv.innerText = 'System error occurred.';
  }
}

async function handleTenantLoginSubmit(e) {
  e.preventDefault();
  const email = document.getElementById('tenantLoginEmail').value.trim();
  const password = document.getElementById('tenantLoginPassword').value.trim();
  const statusDiv = document.getElementById('tenantAuthStatusMessage');

  statusDiv.style.color = 'var(--text-secondary)';
  statusDiv.innerText = 'Signing in...';

  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, tenantId: state.activeTenantId })
    });
    const data = await response.json();

    if (data.error) {
      statusDiv.style.color = 'var(--accent-red)';
      statusDiv.innerText = `Login failed: ${data.error}`;
      return;
    }

    if (data.user.role !== 'TENANT_ADMIN') {
      statusDiv.style.color = 'var(--accent-red)';
      statusDiv.innerText = 'Access Denied: Requiring Tenant Admin role credentials.';
      return;
    }

    // Verify subdomain constraint (prevent logging into tenant_2 on tenant_1.localhost)
    const subdomain = getSubdomain();
    if (subdomain && data.user.tenantId !== subdomain) {
      statusDiv.style.color = 'var(--accent-red)';
      statusDiv.innerText = `Access Denied: Mismatched tenant boundary. This domain is locked to '${subdomain}'.`;
      return;
    }

    // Capture and save tenant session
    state.tenantToken = data.token;
    state.tenantUser = data.user;
    localStorage.setItem('tenantToken', data.token);
    localStorage.setItem('tenantUser', JSON.stringify(data.user));

    // Reset login form inputs
    document.getElementById('tenantLoginForm').reset();
    statusDiv.innerText = '';

    // Switch View to Tenant Admin Dashboard
    loginAndSwitchRole('TENANT_ADMIN');

  } catch (err) {
    statusDiv.style.color = 'var(--accent-red)';
    statusDiv.innerText = `Auth exception: ${err.message}`;
  }
}

async function handleCategoryFormSubmit() {
  const name = document.getElementById('categoryFormName').value.trim();
  const displayOrder = document.getElementById('categoryFormOrder').value;
  const statusDiv = document.getElementById('categoryFormStatusMessage');

  if (!name) {
    statusDiv.style.color = 'var(--accent-red)';
    statusDiv.innerText = 'Category name is required.';
    return;
  }

  statusDiv.style.color = 'var(--text-secondary)';
  statusDiv.innerText = 'Saving...';

  const payload = {
    name,
    displayOrder: displayOrder !== '' ? parseInt(displayOrder, 10) : 0
  };

  try {
    const response = await fetch('/api/tenant/menu/categories', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.token}`,
        'X-Tenant-ID': state.activeTenantId
      },
      body: JSON.stringify(payload)
    });
    const data = await response.json();

    if (data.error) {
      statusDiv.style.color = 'var(--accent-red)';
      statusDiv.innerText = `Save error: ${data.error}`;
      return;
    }

    // Success
    document.getElementById('categoryModal').style.display = 'none';
    refreshTenantDashboard();
  } catch (err) {
    statusDiv.style.color = 'var(--accent-red)';
    statusDiv.innerText = `Save exception: ${err.message}`;
  }
}

// ==========================================
// CONSUMER TABS & ORDER HISTORY HANDLERS
// ==========================================

function switchConsumerTab(tab) {
  const storesBtn = document.getElementById('consumerStoresTabBtn');
  const historyBtn = document.getElementById('consumerHistoryTabBtn');
  const browsingContainer = document.getElementById('consumerBrowsingContainer');
  const historyContainer = document.getElementById('consumerHistoryContainer');
  const cartPanel = document.getElementById('shoppingCartPanel');

  if (tab === 'HISTORY' && !state.consumerToken) {
    document.getElementById('consumerAuthModal').style.display = 'block';
    alert('Please sign in or create an account to view your order history.');
    return;
  }

  state.activeConsumerTab = tab;

  if (tab === 'STORES') {
    storesBtn.className = 'primary-btn';
    historyBtn.className = 'secondary-btn';
    browsingContainer.style.display = 'block';
    historyContainer.style.display = 'none';
    // Only show cart if not actively tracking an order
    if (!state.activeTrackingOrder) {
      cartPanel.style.display = 'block';
    }
  } else if (tab === 'HISTORY') {
    storesBtn.className = 'secondary-btn';
    historyBtn.className = 'primary-btn';
    browsingContainer.style.display = 'none';
    historyContainer.style.display = 'block';
    cartPanel.style.display = 'none';
    refreshConsumerOrderHistory();
  }
}

async function refreshConsumerOrderHistory() {
  const container = document.getElementById('consumerHistoryList');
  container.innerHTML = '<p class="empty-message">Loading your order history...</p>';

  try {
    const response = await fetch('/api/storefront/orders/history', {
      headers: {
        'Authorization': `Bearer ${state.consumerToken}`
      }
    });
    const orders = await response.json();
    container.innerHTML = '';

    if (orders.length === 0) {
      container.innerHTML = '<p class="empty-message">You have not placed any orders yet. Choose a restaurant to get started!</p>';
      return;
    }

    orders.forEach(order => {
      const card = document.createElement('div');
      card.className = 'tenant-card';
      card.style.border = '1px solid var(--bg-tertiary)';
      card.style.background = 'rgba(255,255,255,0.02)';
      card.style.padding = '16px';
      card.style.marginBottom = '8px';

      // Items list summary
      const itemsSummary = order.items.map(item => `${item.name} x${item.quantity}`).join(', ');
      const totalCost = (order.total_cents / 100).toFixed(2);
      const dateText = new Date(order.created_at).toLocaleString();

      // Show "Track Live" button for active orders
      const isActive = !['DELIVERED', 'CANCELLED'].includes(order.status);
      const trackBtnHtml = isActive 
        ? `<button class="primary-btn green-btn" style="padding: 6px 12px; font-size: 11px; margin-top: 10px;" onclick="trackOrderLive('${order.id}', '${order.tenantId}')">Track Live Delivery</button>`
        : '';

      card.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 8px;">
          <div>
            <h4 style="margin: 0; color: var(--accent-blue);">${order.restaurantName}</h4>
            <span style="font-size: 10px; color: var(--text-muted);">Order ID: ${order.id} | ${dateText}</span>
          </div>
          <span class="badge ${order.status.toLowerCase()}">${order.status}</span>
        </div>
        <p style="font-size: 13px; margin: 4px 0; color: var(--text-main); font-weight: 500;">Items: ${itemsSummary}</p>
        <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 8px; border-top: 1px solid var(--bg-tertiary); padding-top: 8px;">
          <span style="font-size: 12px; color: var(--text-secondary);">Method: <strong>${order.payment_method}</strong> (${order.payment_status})</span>
          <span style="font-size: 14px; font-weight: 700; color: var(--text-main);">Paid: ₹${totalCost}</span>
        </div>
        ${trackBtnHtml}
      `;
      container.appendChild(card);
    });
  } catch (err) {
    console.error('Failed to load order history:', err);
    container.innerHTML = '<p class="empty-message error-message">Failed to load order history. Access denied.</p>';
  }
}

window.trackOrderLive = async function(orderId, tenantId) {
  try {
    const response = await fetch(`/api/storefront/orders/${orderId}/track`, {
      headers: {
        'Authorization': `Bearer ${state.consumerToken}`,
        'X-Tenant-ID': tenantId
      }
    });
    const trackingData = await response.json();
    if (trackingData.error) {
      alert(`Tracking error: ${trackingData.error}`);
      return;
    }

    // Set tracking context
    state.activeTrackingOrder = {
      orderId: trackingData.orderId,
      status: trackingData.status,
      restLat: trackingData.restLat,
      restLng: trackingData.restLng,
      custLat: trackingData.custLat,
      custLng: trackingData.custLng,
      driverLat: trackingData.driverLat,
      driverLng: trackingData.driverLng,
      driverName: trackingData.driverName,
      fulfillmentType: trackingData.fulfillmentType,
      pickupCode: trackingData.pickupCode
    };

    // Toggle tabs back to STORES view
    switchConsumerTab('STORES');

    // Show tracking panel, hide listings and basket
    document.getElementById('storefrontDiscoverPanel').style.display = 'none';
    document.getElementById('storefrontMenuPanel').style.display = 'none';
    document.getElementById('shoppingCartPanel').style.display = 'none';
    document.getElementById('orderTrackingPanel').style.display = 'block';

    const consumerGrid = document.querySelector('.consumer-grid');
    consumerGrid.classList.add('tracking-active');

    // Update tracking status details and render map
    updateTrackingProgressSteps(trackingData.status);
    document.getElementById('trackingStatusBadge').innerText = trackingData.status;
    document.getElementById('trackingStatusBadge').className = `tracking-badge ${trackingData.status.toLowerCase()}`;
    
    if (trackingData.driverName) {
      document.getElementById('trackingDriverLabel').innerText = `Delivery Partner: ${trackingData.driverName} (Assigned)`;
    } else {
      document.getElementById('trackingDriverLabel').innerText = 'Locating proximity courier partner...';
    }

    // Draw canvas map route
    renderTrackingMap();

    // Ensure socket updates are active
    connectWebSocket();

  } catch (err) {
    console.error('Error opening trackOrderLive:', err);
  }
};

window.openDishDetailModal = function(categoryId, itemId) {
  // Find item details from cached tenant menu structure
  const cat = state.tenantMenu.find(c => c.id === categoryId);
  if (!cat) return;
  const item = cat.items.find(i => i.id === itemId);
  if (!item) return;

  // Set popup fields
  document.getElementById('detailDishName').innerText = item.name;
  document.getElementById('detailDishCategory').innerText = cat.name;
  document.getElementById('detailDishDesc').innerText = item.description || 'No description provided.';
  
  const discountText = item.discount_price_cents 
    ? `<span style="text-decoration: line-through; color: var(--text-muted); font-size: 12px; margin-right: 5px;">₹${(item.base_price_cents/100).toFixed(2)}</span>
       <span style="color: var(--accent-green); font-weight: 700;">₹${(item.discount_price_cents/100).toFixed(2)}</span>`
    : `₹${(item.base_price_cents/100).toFixed(2)}`;
  document.getElementById('detailDishPrice').innerHTML = discountText;
  
  document.getElementById('detailDishDietary').innerText = item.dietary_tag || 'None';
  
  const statusLabel = document.getElementById('detailDishStatus');
  statusLabel.innerText = item.is_available === 1 ? 'Active / Available in Store' : 'Inactive / Hidden';
  statusLabel.style.color = item.is_available === 1 ? 'var(--accent-green)' : 'var(--accent-red)';

  // Handle Photo Container display & Slider Setup
  const photoContainer = document.getElementById('detailDishPhotoContainer');
  const imgElement = document.getElementById('detailDishPhoto');
  const prevBtn = document.getElementById('detailDishPrevBtn');
  const nextBtn = document.getElementById('detailDishNextBtn');
  const sliderIndicator = document.getElementById('detailDishSliderIndicator');

  let images = [];
  try {
    images = item.images ? JSON.parse(item.images) : (item.image_url ? [item.image_url] : []);
  } catch (e) {
    images = item.image_url ? [item.image_url] : [];
  }

  if (images && images.length > 0) {
    state.activeDetailPhotoIndex = 0;
    photoContainer.style.display = 'block';

    const updateSlider = () => {
      imgElement.style.opacity = 0;
      setTimeout(() => {
        imgElement.src = images[state.activeDetailPhotoIndex];
        imgElement.style.opacity = 1;
      }, 150);

      sliderIndicator.innerText = `${state.activeDetailPhotoIndex + 1}/${images.length}`;
    };

    updateSlider();

    if (images.length > 1) {
      prevBtn.style.display = 'flex';
      nextBtn.style.display = 'flex';
      sliderIndicator.style.display = 'block';

      prevBtn.onclick = (e) => {
        e.stopPropagation();
        state.activeDetailPhotoIndex = (state.activeDetailPhotoIndex - 1 + images.length) % images.length;
        updateSlider();
      };

      nextBtn.onclick = (e) => {
        e.stopPropagation();
        state.activeDetailPhotoIndex = (state.activeDetailPhotoIndex + 1) % images.length;
        updateSlider();
      };
    } else {
      prevBtn.style.display = 'none';
      nextBtn.style.display = 'none';
      sliderIndicator.style.display = 'none';
    }
  } else {
    photoContainer.style.display = 'none';
  }

  // Bind the edit button inside this modal to trigger upsert modal
  document.getElementById('detailDishEditBtn').onclick = () => {
    document.getElementById('dishDetailModal').style.display = 'none';
    openEditDishModal(categoryId, itemId);
  };

  // Open modal
  document.getElementById('dishDetailModal').style.display = 'flex';
};

function renderDishFormImages() {
  const container = document.getElementById('dishFormImagesList');
  if (!container) return;
  container.innerHTML = '';
  
  state.editingDishImages.forEach((imgUrl, index) => {
    const chip = document.createElement('div');
    chip.style.position = 'relative';
    chip.style.width = '60px';
    chip.style.height = '60px';
    chip.style.borderRadius = '6px';
    chip.style.overflow = 'hidden';
    chip.style.border = '1px solid var(--bg-tertiary)';
    
    chip.innerHTML = `
      <img src="${imgUrl}" style="width:100%; height:100%; object-fit:cover;">
      <button type="button" onclick="removeFormDishImage(${index})" style="position:absolute; top:2px; right:2px; background:rgba(239,68,68,0.85); color:#fff; border:none; border-radius:50%; width:16px; height:16px; font-size:10px; cursor:pointer; display:flex; align-items:center; justify-content:center; padding:0; line-height:1;">&times;</button>
    `;
    container.appendChild(chip);
  });

  const statusLabel = document.getElementById('dishPhotoUploadStatus');
  if (state.editingDishImages.length > 0) {
    statusLabel.innerText = `✓ ${state.editingDishImages.length} photo(s) uploaded.`;
    statusLabel.style.color = 'var(--accent-green)';
  } else {
    statusLabel.innerText = 'No photos uploaded.';
    statusLabel.style.color = 'var(--text-muted)';
  }
}

window.removeFormDishImage = function(index) {
  state.editingDishImages.splice(index, 1);
  renderDishFormImages();
};

window.switchTenantTab = function(tab) {
  const ordersCard = document.getElementById('tenantOrdersCard');
  const menuCard = document.getElementById('tenantMenuCard');
  const consumersCard = document.getElementById('tenantConsumersCard');
  const settingsCard = document.getElementById('tenantSettingsCard');
  
  const ordersBtn = document.getElementById('tenantOrdersTabBtn');
  const menuBtn = document.getElementById('tenantMenuTabBtn');
  const consumersBtn = document.getElementById('tenantConsumersTabBtn');
  const settingsBtn = document.getElementById('tenantSettingsTabBtn');

  if (tab === 'ORDERS') {
    ordersCard.style.display = 'block';
    menuCard.style.display = 'none';
    consumersCard.style.display = 'none';
    if (settingsCard) settingsCard.style.display = 'none';
    ordersBtn.className = 'primary-btn';
    menuBtn.className = 'secondary-btn';
    consumersBtn.className = 'secondary-btn';
    if (settingsBtn) settingsBtn.className = 'secondary-btn';
  } else if (tab === 'MENU') {
    ordersCard.style.display = 'none';
    menuCard.style.display = 'block';
    consumersCard.style.display = 'none';
    if (settingsCard) settingsCard.style.display = 'none';
    ordersBtn.className = 'secondary-btn';
    menuBtn.className = 'primary-btn';
    consumersBtn.className = 'secondary-btn';
    if (settingsBtn) settingsBtn.className = 'secondary-btn';
  } else if (tab === 'CONSUMERS') {
    ordersCard.style.display = 'none';
    menuCard.style.display = 'none';
    consumersCard.style.display = 'block';
    if (settingsCard) settingsCard.style.display = 'none';
    ordersBtn.className = 'secondary-btn';
    menuBtn.className = 'secondary-btn';
    consumersBtn.className = 'primary-btn';
    if (settingsBtn) settingsBtn.className = 'secondary-btn';
    fetchAndRenderTenantConsumers();
  } else if (tab === 'SETTINGS') {
    ordersCard.style.display = 'none';
    menuCard.style.display = 'none';
    consumersCard.style.display = 'none';
    if (settingsCard) settingsCard.style.display = 'block';
    ordersBtn.className = 'secondary-btn';
    menuBtn.className = 'secondary-btn';
    consumersBtn.className = 'secondary-btn';
    if (settingsBtn) settingsBtn.className = 'primary-btn';
    fetchAndLoadTenantSettings();
  }
};

async function fetchAndRenderTenantConsumers() {
  const tbody = document.querySelector('#tenantConsumersTable tbody');
  const countLabel = document.getElementById('tenantConsumersCount');
  tbody.innerHTML = '<tr><td colspan="6" class="empty-message">Loading consumers list...</td></tr>';

  try {
    const response = await fetch('/api/tenant/consumers', {
      headers: {
        'Authorization': `Bearer ${state.token}`
      }
    });
    const consumers = await response.json();
    tbody.innerHTML = '';

    if (consumers.error) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty-message error-message">Failed: ${consumers.error}</td></tr>`;
      countLabel.innerText = '0 consumers';
      return;
    }

    if (consumers.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-message">No consumers registered on the platform yet.</td></tr>';
      countLabel.innerText = '0 consumers';
      return;
    }

    countLabel.innerText = `${consumers.length} consumer(s)`;

    consumers.forEach(user => {
      const tr = document.createElement('tr');
      const registeredDate = user.created_at ? new Date(user.created_at).toLocaleString() : 'Seeded';
      tr.innerHTML = `
        <td><code>${user.id}</code></td>
        <td>${user.first_name}</td>
        <td>${user.last_name}</td>
        <td>${user.email}</td>
        <td>${user.phone || '-'}</td>
        <td>${registeredDate}</td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    console.error('Failed to load registered consumers directory:', err);
    tbody.innerHTML = '<tr><td colspan="6" class="empty-message error-message">Failed to load consumer directory list.</td></tr>';
    countLabel.innerText = 'Error';
  }
}

window.switchPlatformTab = function(tab) {
  const listTab = document.getElementById('platformTenantListTab');
  const addTab = document.getElementById('platformAddTenantTab');
  const listBtn = document.getElementById('platformTenantListTabBtn');
  const addBtn = document.getElementById('platformAddTenantTabBtn');

  if (tab === 'LIST') {
    if (listTab) listTab.style.display = 'block';
    if (addTab) addTab.style.display = 'none';
    if (listBtn) {
      listBtn.style.background = 'var(--bg-tertiary)';
      listBtn.style.color = 'var(--text-main)';
    }
    if (addBtn) {
      addBtn.style.background = 'none';
      addBtn.style.color = 'var(--text-secondary)';
    }
    refreshPlatformAdminDashboard();
  } else if (tab === 'ADD') {
    if (listTab) listTab.style.display = 'none';
    if (addTab) addTab.style.display = 'block';
    if (listBtn) {
      listBtn.style.background = 'none';
      listBtn.style.color = 'var(--text-secondary)';
    }
    if (addBtn) {
      addBtn.style.background = 'var(--bg-tertiary)';
      addBtn.style.color = 'var(--text-main)';
    }
  }
}

async function fetchAndLoadTenantSettings() {
  const statusMsg = document.getElementById('tenantSettingsStatusMessage');
  if (statusMsg) statusMsg.innerText = 'Loading storefront configuration...';

  try {
    const response = await fetch('/api/tenant/settings', {
      headers: {
        'Authorization': `Bearer ${state.token}`,
        'X-Tenant-ID': state.activeTenantId
      }
    });
    const settings = await response.json();
    
    document.getElementById('settingAllowDelivery').checked = settings.delivery_enabled !== 0;
    document.getElementById('settingAllowPickup').checked = settings.pickup_enabled !== 0;
    
    if (statusMsg) statusMsg.innerText = '';
  } catch (err) {
    console.error('Failed to load settings:', err);
    if (statusMsg) {
      statusMsg.innerText = 'Failed to load storefront settings.';
      statusMsg.className = 'status-message error-message';
    }
  }
}

async function handleTenantSettingsSubmit(e) {
  e.preventDefault();
  const statusMsg = document.getElementById('tenantSettingsStatusMessage');
  if (statusMsg) {
    statusMsg.innerText = 'Saving settings...';
    statusMsg.className = 'status-message';
  }

  const deliveryEnabled = document.getElementById('settingAllowDelivery').checked;
  const pickupEnabled = document.getElementById('settingAllowPickup').checked;

  try {
    const response = await fetch('/api/tenant/settings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.token}`,
        'X-Tenant-ID': state.activeTenantId
      },
      body: JSON.stringify({ deliveryEnabled, pickupEnabled })
    });
    const data = await response.json();
    
    if (statusMsg) {
      statusMsg.innerText = 'Storefront settings saved successfully!';
      statusMsg.className = 'status-message success-message';
    }
  } catch (err) {
    console.error('Failed to save settings:', err);
    if (statusMsg) {
      statusMsg.innerText = 'Failed to save storefront settings.';
      statusMsg.className = 'status-message error-message';
    }
  }
}


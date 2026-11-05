// E-commerce Server site
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
require("dotenv").config();
const cloudinary = require("cloudinary").v2;
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const port = process.env.PORT || 5000;

const app = express();

// ============================================
// CORS CONFIGURATION
// ============================================
const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:3000",
  process.env.CLIENT_URL,
  "https://anisabaya.vercel.app",
  "https://anis-abaiya.web.app",
  "https://anis-abaiya.firebaseapp.com"
].filter(Boolean); // Remove undefined values



app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1) {
      const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  optionsSuccessStatus: 200
}));

app.use(cookieParser());

let addressesCollection, ordersCollection, cartsCollection, productsCollection, usersCollection, wishlistsCollection, couponsCollection, countersCollection;;

// Add this BEFORE express.json() middleware
app.post("/api/webhook", 
  express.raw({ type: 'application/json' }), 
  async (req, res) => {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(' STRIPE WEBHOOK RECEIVED');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    const sig = req.headers['stripe-signature'];
    
    if (!sig) {
      console.error('❌ No Stripe signature found');
      return res.status(400).send('No Stripe signature');
    }

    console.log('✅ Signature present');

    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
      
      console.log('✅ Webhook signature verified');
      console.log('📦 Event Type:', event.type);
      console.log('🆔 Event ID:', event.id);
      
    } catch (err) {
      console.error('❌ Webhook signature verification FAILED');
      console.error('   Error:', err.message);
      console.error('   Webhook Secret Configured:', !!process.env.STRIPE_WEBHOOK_SECRET);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle the event
    try {
      switch (event.type) {
        case 'checkout.session.completed':
          const session = event.data.object;
          
          console.log('💳 Checkout Session Completed');
          console.log('   Order ID:', session.client_reference_id);
          console.log('   Session ID:', session.id);
          console.log('   Payment Intent:', session.payment_intent);
          console.log('   Payment Status:', session.payment_status);
          
          if (session.payment_status === 'paid') {
            console.log('✅ Payment confirmed - processing...');
            await handleSuccessfulPayment(session);
          } else {
            console.log('⚠️ Payment status not "paid":', session.payment_status);
          }
          break;

        case 'checkout.session.expired':
          console.log('⏰ Checkout session expired:', event.data.object.id);
          break;

        case 'payment_intent.succeeded':
          console.log('✅ Payment Intent succeeded:', event.data.object.id);
          break;

        case 'payment_intent.payment_failed':
          console.log('❌ Payment Intent failed:', event.data.object.id);
          break;

        default:
          console.log('ℹ️ Unhandled event type:', event.type);
      }
    } catch (error) {
      console.error('❌ Error processing webhook:', error);
      console.error('   Stack:', error.stack);
      return res.status(500).json({ received: false, error: 'Webhook processing failed' });
    }

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    res.json({ received: true });
  }
);



app.use(express.json());

// ============================================
// CLOUDINARY CONFIGURATION
// ============================================

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// ============================================
// MEDIA HELPERS (Cloudinary + Product media)
// ============================================

const MAX_PRODUCT_VIDEOS = 3;

// Video list normalize: legacy single object / array / null সব handle করে।
// publicId ও url ছাড়া entry বাদ যায়, duplicate publicId বাদ যায়।
function normalizeVideoList(input) {
  const list = Array.isArray(input) ? input : input ? [input] : [];
  const seen = new Set();
  const result = [];

  for (const video of list) {
    if (!video || typeof video !== 'object') continue;
    if (!video.publicId || !video.url) continue;
    if (seen.has(video.publicId)) continue;

    seen.add(video.publicId);
    result.push({
      url: video.url,
      publicId: video.publicId,
      thumbnailUrl: video.thumbnailUrl || '',
      duration: video.duration ?? null,
    });
  }

  return result;
}

// Request body-তে video সংক্রান্ত কোনো field আছে কি না।
function hasVideoInput(data) {
  return (
    data.videos !== undefined ||
    data.video !== undefined ||
    data.media?.videos !== undefined ||
    data.media?.video !== undefined
  );
}

// Body থেকে videos[] বের করে নতুন structure বসায়:
//   media.videos (canonical), media.video ও video (legacy mirror = প্রথম video)
// Error হলে message string ফেরত দেয়, নাহলে null।
function applyVideoStructure(data) {
  if (!hasVideoInput(data)) return null;

  const source =
    data.media?.videos ?? data.media?.video ?? data.videos ?? data.video;

  const videos = normalizeVideoList(source);

  if (videos.length > MAX_PRODUCT_VIDEOS) {
    return `Maximum ${MAX_PRODUCT_VIDEOS} videos allowed per product`;
  }

  data.videos = videos;
  data.video = videos[0] || null;
  data.media = {
    ...(data.media || {}),
    videos,
    video: videos[0] || null,
  };

  return null;
}

// Product থেকে সব Cloudinary asset (image + video, legacy সহ) সংগ্রহ।
function collectProductMedia(product) {
  const assets = new Map();

  const addAsset = (item, resourceType) => {
    if (item?.publicId) {
      assets.set(`${resourceType}:${item.publicId}`, {
        publicId: item.publicId,
        resourceType,
      });
    }
  };

  (Array.isArray(product.media?.images) ? product.media.images : []).forEach(
    (img) => addAsset(img, 'image')
  );
  (Array.isArray(product.images) ? product.images : []).forEach((img) =>
    addAsset(img, 'image')
  );

  (Array.isArray(product.media?.videos) ? product.media.videos : []).forEach(
    (vid) => addAsset(vid, 'video')
  );
  addAsset(product.media?.video, 'video');
  (Array.isArray(product.videos) ? product.videos : []).forEach((vid) =>
    addAsset(vid, 'video')
  );
  addAsset(product.video, 'video');

  return Array.from(assets.values());
}

// কোনো product এখনো এই publicId ব্যবহার করছে কি না।
async function isCloudinaryAssetInUse(publicId) {
  const product = await productsCollection.findOne(
    {
      $or: [
        { 'media.images.publicId': publicId },
        { 'media.videos.publicId': publicId },
        { 'media.video.publicId': publicId },
        { 'images.publicId': publicId },
        { 'videos.publicId': publicId },
        { 'video.publicId': publicId },
      ],
    },
    { projection: { _id: 1 } }
  );

  return Boolean(product);
}

// DELETE /cloudinary/delete/image ও /video দুটোর shared handler।
async function handleCloudinaryDelete(req, res, resourceType) {
  try {
    const { publicId } = req.body || {};

    if (!publicId || typeof publicId !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'Public ID is required',
      });
    }

    const config = cloudinary.config();
    if (!config.cloud_name || !config.api_key || !config.api_secret) {
      return res.status(500).json({
        success: false,
        message: 'Cloudinary configuration error',
      });
    }

    // Safety guard: saved product এখনো ব্যবহার করলে delete করা যাবে না।
    if (await isCloudinaryAssetInUse(publicId)) {
      return res.status(409).json({
        success: false,
        inUse: true,
        message: `This ${resourceType} is still used by a saved product and was not deleted`,
      });
    }

    const result = await cloudinary.uploader.destroy(publicId, {
      invalidate: true,
      resource_type: resourceType,
    });

    if (result.result === 'ok') {
      return res.json({
        success: true,
        status: 'deleted',
        resourceType,
        publicId,
        message: `${resourceType} deleted successfully from Cloudinary`,
        result,
      });
    }

    if (result.result === 'not found') {
      return res.json({
        success: true,
        status: 'not_found',
        resourceType,
        publicId,
        message: `${resourceType} not found (may already be deleted)`,
        result,
      });
    }

    return res.status(502).json({
      success: false,
      status: 'failed',
      resourceType,
      publicId,
      message: `Cloudinary could not delete the ${resourceType}`,
      result,
    });
  } catch (err) {
    console.error(`Cloudinary ${resourceType} delete error:`, {
      message: err.message,
      name: err.name,
      http_code: err.http_code,
    });

    return res.status(500).json({
      success: false,
      message: err.message || `Error deleting ${resourceType} from Cloudinary`,
    });
  }
}

// ============================================
// PRODUCT VALIDATION HELPERS
// ============================================

const SIZE_CHART = [
  { size: 'S', length: 52 },
  { size: 'M', length: 54 },
  { size: 'L', length: 56 },
  { size: 'XL', length: 58 },
  { size: 'XXL', length: 60 },
  { size: '3XL', length: 62 },
];
const KNOWN_SIZES = SIZE_CHART.map((s) => s.size);
const PRODUCT_CATEGORIES = ['abaya', 'hijab'];
const PRODUCT_STATUSES = ['active', 'draft', 'archived'];
const MAX_PRODUCT_IMAGES = 10;
const MAX_INVENTORY_COLORS = 100;
const MAX_STOCK_PER_CELL = 1000000;

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const cleanString = (value) => (typeof value === 'string' ? value.trim() : '');

const generateSlug = (name, fallback) => {
  const slug = String(name || '')
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
  return slug || String(fallback || '').toLowerCase();
};

// Tags / categories: trim, খালি বাদ, case-insensitive duplicate বাদ।
function normalizeStringList(input, label, errors, maxItems = 50, maxLength = 60) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) {
    errors.push(`${label} must be a list`);
    return [];
  }

  const seen = new Set();
  const result = [];

  for (const raw of input) {
    if (typeof raw !== 'string') {
      errors.push(`${label} contains an invalid entry`);
      continue;
    }
    const value = raw.trim();
    if (!value) continue;
    if (value.length > maxLength) {
      errors.push(`${label} entry "${value.slice(0, 20)}..." is too long`);
      continue;
    }
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }

  if (result.length > maxItems) errors.push(`Maximum ${maxItems} ${label} allowed`);
  return result;
}

// inventory: [{ color, sizes: [{ size, stock }] }]
// প্রতিটি color-এ সবসময় ৬টি official size থাকে। না এলে stock = 0।
function normalizeInventory(input, errors) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) {
    errors.push('Inventory must be a list of colors');
    return [];
  }
  if (input.length > MAX_INVENTORY_COLORS) {
    errors.push(`Maximum ${MAX_INVENTORY_COLORS} colors allowed`);
    return [];
  }

  const seen = new Set();
  const result = [];

  for (const entry of input) {
    const color = cleanString(entry?.color);

    if (!color) {
      errors.push('Every inventory row needs a color name');
      continue;
    }
    if (color.length > 50) {
      errors.push(`Color name "${color.slice(0, 20)}..." is too long`);
      continue;
    }

    const key = color.toLowerCase();
    if (seen.has(key)) {
      errors.push(`Duplicate color: ${color}`);
      continue;
    }
    seen.add(key);

    const given = Array.isArray(entry.sizes) ? entry.sizes : [];

    for (const row of given) {
      if (!KNOWN_SIZES.includes(row?.size)) {
        errors.push(`Unknown size "${row?.size}" for color ${color}`);
      }
    }

    const sizes = SIZE_CHART.map(({ size }) => {
      const row = given.find((r) => r?.size === size);
      const raw = row?.stock;

      if (raw === undefined || raw === null || raw === '') {
        return { size, stock: 0 };
      }

      const stock = typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : NaN;

      if (!Number.isInteger(stock) || stock < 0 || stock > MAX_STOCK_PER_CELL) {
        errors.push(`Stock for ${color} / ${size} must be a whole number of 0 or more`);
        return { size, stock: 0 };
      }

      return { size, stock };
    });

    result.push({ color, sizes });
  }

  return result;
}

// Client-এর stock/sizes/colors বিশ্বাস না করে inventory থেকে হিসাব।
// sizes/colors: শুধু যেগুলোর কোথাও stock > 0 (Storefront selector-এর জন্য)।
function deriveFromInventory(inventory) {
  let stock = 0;
  const sellableColors = [];
  const sellableSizes = new Set();

  for (const { color, sizes } of inventory) {
    const colorTotal = sizes.reduce((sum, s) => sum + s.stock, 0);
    stock += colorTotal;

    if (colorTotal > 0) {
      sellableColors.push(color);
      sizes.forEach((s) => s.stock > 0 && sellableSizes.add(s.size));
    }
  }

  return {
    stock,
    colors: sellableColors,
    sizes: KNOWN_SIZES.filter((size) => sellableSizes.has(size)),
  };
}

function normalizeImageList(input, errors) {
  const list = Array.isArray(input) ? input : [];
  const seen = new Set();
  const result = [];

  for (const image of list) {
    if (!image || typeof image !== 'object' || !image.url || !image.publicId) {
      errors.push('Every image needs a url and publicId');
      continue;
    }
    if (seen.has(image.publicId)) continue;
    seen.add(image.publicId);

    result.push({
      url: image.url,
      publicId: image.publicId,
      thumbnailUrl: image.thumbnailUrl || image.url,
      isMain: image.isMain === true,
    });
  }

  if (result.length > MAX_PRODUCT_IMAGES) {
    errors.push(`Maximum ${MAX_PRODUCT_IMAGES} images allowed`);
  }

  let mainIndex = result.findIndex((image) => image.isMain);
  if (mainIndex === -1 && result.length > 0) mainIndex = 0;

  return result.map((image, index) => ({
    ...image,
    isMain: index === mainIndex,
    order: index,
  }));
}

// Create ও Update দুটোর জন্য একই validation। শুধু whitelist করা field ফেরত দেয়।
// existing থাকলে (Update) না-পাঠানো field আগের মান থেকে নেয়।
function buildProductDocument(body, existing = null) {
  const errors = [];
  const pick = (key) => (body[key] !== undefined ? body[key] : existing?.[key]);

  // Basic
  const sku = cleanString(pick('sku'));
  const productName = cleanString(pick('productName'));
  const mainCategory = cleanString(pick('mainCategory')).toLowerCase();
  const status = cleanString(pick('status')) || 'active';

  if (!sku) errors.push('SKU is required');
  else if (sku.length > 60) errors.push('SKU is too long');

  if (!productName) errors.push('Product name is required');
  else if (productName.length > 200) errors.push('Product name is too long');

  if (!PRODUCT_CATEGORIES.includes(mainCategory)) {
    errors.push('Main category must be Abaya or Hijab');
  }
  if (!PRODUCT_STATUSES.includes(status)) {
    errors.push('Invalid product status');
  }

  // Pricing
  const newPrice = Number(pick('newPrice'));
  if (!Number.isFinite(newPrice) || newPrice <= 0) {
    errors.push('Wholesale price must be a number greater than 0');
  }

  let oldPrice = null;
  const rawOld = pick('oldPrice');
  if (rawOld !== undefined && rawOld !== null && rawOld !== '' && Number(rawOld) !== 0) {
    oldPrice = Number(rawOld);
    if (!Number.isFinite(oldPrice) || oldPrice < 0) {
      errors.push('Compare-at price must be a valid number');
    } else if (Number.isFinite(newPrice) && oldPrice < newPrice) {
      errors.push('Compare-at price must not be lower than the wholesale price');
    }
  }

  // Inventory (stock এখানেই নির্ধারিত হয়)
  const inventory = normalizeInventory(pick('inventory'), errors);
  const { stock, colors, sizes } = deriveFromInventory(inventory);

  // Media
  const imageSource =
    body.media?.images ?? body.images ?? existing?.media?.images ?? existing?.images;
  const images = normalizeImageList(imageSource, errors);

  const videoSource = hasVideoInput(body)
    ? body.media?.videos ?? body.videos ?? body.media?.video ?? body.video
    : existing?.media?.videos ?? existing?.videos ?? existing?.media?.video ?? existing?.video;
  const videos = normalizeVideoList(videoSource);
  if (videos.length > MAX_PRODUCT_VIDEOS) {
    errors.push(`Maximum ${MAX_PRODUCT_VIDEOS} videos allowed per product`);
  }

  // Description
  const rawDescription = pick('descriptionHtml');
  const descriptionHtml = typeof rawDescription === 'string' ? rawDescription : '';
  if (descriptionHtml.length > 100000) errors.push('Description is too long');

  // Additional info
  const info = pick('additionalInfo') || {};
  const additionalInfo = {
    fabric: cleanString(info.fabric),
    workType: cleanString(info.workType),
    washCare: cleanString(info.washCare),
    countryOfOrigin: cleanString(info.countryOfOrigin) || 'UAE',
    hijabIncluded: info.hijabIncluded === true,
  };
  if (additionalInfo.washCare.length > 1000) errors.push('Wash & care text is too long');
  if (additionalInfo.fabric.length > 100 || additionalInfo.workType.length > 100) {
    errors.push('Fabric / work type text is too long');
  }

  const categories = normalizeStringList(pick('categories'), 'Categories', errors);
  const tags = normalizeStringList(pick('tags'), 'Tags', errors);

  // Active product-এর জন্য কঠোর নিয়ম। Draft অসম্পূর্ণ থাকতে পারে।
  if (status === 'active') {
    if (images.length < 1) errors.push('At least one product image is required');
    if (inventory.length < 1) errors.push('Add at least one color with stock quantities');
    if (descriptionHtml.replace(/<[^>]*>/g, '').trim().length < 50) {
      errors.push('Description must be at least 50 characters');
    }
  }

  return {
    errors,
    doc: {
      sku,
      productName,
      slug: generateSlug(productName, sku),
      status,
      mainCategory,
      newPrice,
      oldPrice,
      stock,
      sizes,
      colors,
      inventory,
      categories,
      tags,
      descriptionHtml,
      additionalInfo,
      images,
      videos,
      video: videos[0] || null,
      media: { images, videos, video: videos[0] || null },
    },
  };
}


// ============================================
// FIREBASE ADMIN INITIALIZATION
// ============================================
const admin = require('firebase-admin');

try {
  // Base64 decode
  const decoded = Buffer.from(process.env.FB_SERVICE_KEY, 'base64').toString('utf8');
  // JSON parse
  const serviceAccount = JSON.parse(decoded);
  
  // Firebase initialize
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log('Firebase Admin initialized successfully');
  }
} catch (error) {
  console.error('Firebase initialization error:', error.message);
  throw error;
}

// ============================================
// AUTHENTICATION MIDDLEWARE
// ============================================

// JWT Token verification (for cookie-based auth)

const verifyToken = (req, res, next) => {
  const token = req?.cookies?.access_token;

  if (!token) {
    return res.status(401).json({ 
      success: false,
      message: "Unauthorized access, token missing" 
    });
  }

  jwt.verify(token, process.env.JWT_ACCESS_SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).json({ 
        success: false,
        message: "Invalid access token" 
      });
    }
    req.decoded = decoded;
    next();
  });
}

  // Firebase Token verification
  const verifyFirebaseToken = async (req, res, next) => {
    try {
      const authHeader = req?.headers?.authorization;
      
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ 
          success: false,
          message: "No token provided" 
        });
      }

      const token = authHeader.split(' ')[1];
      
      // Verify Firebase ID token
      const decodedToken = await admin.auth().verifyIdToken(token);
      
      // Attach user info to request
      req.uid = decodedToken.uid;
      req.tokenEmail = decodedToken.email;
      req.emailVerified = decodedToken.email_verified;
      
      next();
    } catch (error) {
      console.error('Token verification error:', error.code);
      
      if (error.code === 'auth/id-token-expired') {
        return res.status(401).json({
          success: false,
          message: 'Token expired. Please login again.'
        });
      }
      
      return res.status(401).json({
        success: false,
        message: 'Invalid token',
        error: error.message
      });
    }
  };


  // Admin verification
  const verifyAdmin = async (req, res, next) => {
    try {
      const email = req.tokenEmail;
      
      if (!email) {
        return res.status(401).json({
          success: false,
          message: 'Authentication required'
        });
      }

      const user = await usersCollection.findOne({ 
        email: email.toLowerCase() 
      });

      if (!user || user.role !== 'admin') {
        return res.status(403).json({
          success: false,
          message: 'Admin access required'
        });
      }

      req.user = user;
      next();
    } catch (error) {
      console.error('Admin verification error:', error);
      res.status(500).json({
        success: false,
        message: 'Error verifying admin access',
        error: error.message
      });
    }
  };

// Staff verification
const verifyStaff = async (req, res, next) => {
  try {
    const email = req.tokenEmail;
    
    if (!email) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
    }

    const user = await usersCollection.findOne({ 
      email: email.toLowerCase() 
    });

    if (!user || (user.role !== 'admin' && user.role !== 'staff')) {
      return res.status(403).json({
        success: false,
        message: 'Staff or Admin access required'
      });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error('Staff verification error:', error);
    res.status(500).json({
      success: false,
      message: 'Error verifying staff access',
      error: error.message
    });
  }
};


const verifyEmailToken = (req, res, next) => {
  const userId = req.params.userId;
  const authenticatedEmail = req.decoded.email;

  if (userId !== authenticatedEmail) {
          return res.status(403).json({ 
            error: "Forbidden access: User ID does not match token" 
          });
        }
        next()
}

const blockTestInProd = (req, res, next) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ success: false, message: 'Not found' });
  }
  next();
};

const verifyCartOwner = (req, res, next) => {
  const requested = decodeURIComponent(req.params.userId || '').toLowerCase();
  const email = (req.tokenEmail || '').toLowerCase();
  const uid = (req.uid || '').toLowerCase();
  if (!requested || (requested !== email && requested !== uid)) {
    return res.status(403).json({
      success: false,
      message: 'You can only access your own cart'
    });
  }
  next();
};

// ============================================
// WHOLESALE RULES (business rules: স্থির, Admin Settings থেকে বদলায় না)
// ============================================
const MOQ_PER_COLOR = 12;            // প্রতি Product + Color ন্যূনতম
const BULK_DISCOUNT_THRESHOLD = 100; // পুরো অর্ডারের মোট qty
const BULK_DISCOUNT_PERCENT = 5;
const ORDER_CURRENCY = 'AED';
const ALLOW_COUPON_WITH_BULK = true; // false করলে bulk ছাড় পেলে coupon কাজ করবে না

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Stripe / COD ব্যাকএন্ডে ডিফল্ট বন্ধ। .env-এ ENABLE_STRIPE=true / ENABLE_COD=true দিলে চালু।
const ENABLE_STRIPE = process.env.ENABLE_STRIPE === 'true';
const ENABLE_COD = process.env.ENABLE_COD === 'true';

const requireFeature = (enabled, label) => (req, res, next) => {
  if (enabled) return next();
  res.status(403).json({ success: false, message: `${label} is currently not available` });
};

const historyEntry = (status, by, note = '') => ({ status, by, note, at: new Date() });

// ADA-2026-0001 ফরম্যাট। বছর ধরে আলাদা ক্রমিক সংখ্যা (UAE সময়, UTC+4)।
async function generateOrderId(retry = true) {
  const year = new Date(Date.now() + 4 * 60 * 60 * 1000).getUTCFullYear();
  try {
    const result = await countersCollection.findOneAndUpdate(
      { _id: `order-${year}` },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: 'after' }
    );
    const counter = unwrapFindOneAndUpdate(result);
    return `ADA-${year}-${String(counter.seq).padStart(4, '0')}`;
  } catch (err) {
    // বছরের প্রথম দুটি অর্ডার একসাথে এলে upsert-এ duplicate key আসতে পারে: একবার আবার চেষ্টা
    if (err.code === 11000 && retry) return generateOrderId(false);
    throw err;
  }
}

// প্রতিটি Product + Color গ্রুপ আলাদাভাবে ≥ MOQ কি না। size মিশানো চলবে।
function validateMoq(pricedItems) {
  const groups = new Map();

  for (const item of pricedItems) {
    const key = `${item.productId}|${String(item.color ?? '').toLowerCase()}`;
    const group = groups.get(key) || { name: item.name, color: item.color, qty: 0 };
    group.qty += item.qty;
    groups.set(key, group);
  }

  const short = [...groups.values()].filter((g) => g.qty < MOQ_PER_COLOR);

  if (short.length > 0) {
    const detail = short
      .map((g) => `${g.name}${g.color ? ` (${g.color})` : ''}: ${g.qty}/${MOQ_PER_COLOR}`)
      .join(', ');
    const err = new Error(
      `Minimum ${MOQ_PER_COLOR} pieces required for each product and color. ${detail}`
    );
    err.status = 400;
    throw err;
  }
}

function hasInventory(product) {
  return Array.isArray(product?.inventory) && product.inventory.length > 0;
}

// color case-insensitive মেলায়, সঠিক (saved) color নাম ফেরত দেয়
function findInventoryCell(product, color, size) {
  if (!hasInventory(product)) return null;
  const wanted = cleanString(color).toLowerCase();
  const row = product.inventory.find(
    (r) => String(r.color).toLowerCase() === wanted
  );
  if (!row) return null;
  const cell = (row.sizes || []).find((s) => s.size === size);
  if (!cell) return null;
  return { color: row.color, size: cell.size, stock: cell.stock };
}

async function priceCartItems(rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    const err = new Error('Cart is empty');
    err.status = 400;
    throw err;
  }

  const priced = [];
  const demand = new Map(); // একই product+color+size একাধিক line হলে মোট চাহিদা

  for (const item of rawItems) {
    const qty = Number(item.qty);
    if (!item.productId || !Number.isInteger(qty) || qty < 1) {
      const err = new Error('Invalid cart item');
      err.status = 400;
      throw err;
    }

    let product;
    try {
      product = await productsCollection.findOne({ _id: new ObjectId(item.productId) });
    } catch {
      const err = new Error('Invalid product id');
      err.status = 400;
      throw err;
    }

    if (!product || (product.status && product.status !== 'active')) {
      const err = new Error(`Product not available: ${item.name || item.productId}`);
      err.status = 400;
      throw err;
    }

    let color = item.color ?? null;
    let size = item.size ?? null;

    if (hasInventory(product)) {
      // Variant-wise: color + size বাধ্যতামূলক, ওই cell-এর stock চেক
      const cell = findInventoryCell(product, item.color, item.size);
      if (!cell) {
        const err = new Error(
          `Selected color/size is not available for ${product.productName}`
        );
        err.status = 400;
        throw err;
      }

      const demandKey = `${item.productId}|${cell.color}|${cell.size}`;
      const wanted = (demand.get(demandKey) || 0) + qty;
      demand.set(demandKey, wanted);

      if (cell.stock < wanted) {
        const err = new Error(
          `Insufficient stock for ${product.productName} (${cell.color} / ${cell.size})`
        );
        err.status = 400;
        throw err;
      }

      color = cell.color;
      size = cell.size;
    } else if ((product.stock ?? 0) < qty) {
      // পুরোনো product (inventory নেই): আগের global stock চেক
      const err = new Error(`Insufficient stock for ${product.productName}`);
      err.status = 400;
      throw err;
    }

    priced.push({
      key: item.key,
      productId: String(item.productId),
      sku: product.sku || item.sku || '',
      name: product.productName,
      price: Number(product.newPrice),
      oldPrice: product.oldPrice,
      image: product.media?.images?.[0]?.url || product.images?.[0]?.url || '',
      size,
      color,
      qty
    });
  }
  return priced;
}

function computeOrderTotals(pricedItems, couponDoc) {
  const totalQuantity = pricedItems.reduce((sum, item) => sum + item.qty, 0);
  const subtotal = round2(
    pricedItems.reduce((sum, item) => sum + item.price * item.qty, 0)
  );

  // Bulk discount: মোট qty ≥ 100 হলে ৫%, শুধু merchandise subtotal-এ
  const bulkDiscountPercent =
    totalQuantity >= BULK_DISCOUNT_THRESHOLD ? BULK_DISCOUNT_PERCENT : 0;
  const bulkDiscount = round2((subtotal * bulkDiscountPercent) / 100);

  // Coupon: bulk ছাড়ের পরের অংশে। free_shipping coupon-এ এখন ছাড় নেই (delivery মোটে যোগ হয় না)
  let couponDiscount = 0;
  if (couponDoc && (ALLOW_COUPON_WITH_BULK || bulkDiscount === 0)) {
    const base = subtotal - bulkDiscount;

    if (couponDoc.type === 'percentage') {
      couponDiscount = (base * (couponDoc.value || 0)) / 100;
      if (couponDoc.maxDiscount && couponDiscount > couponDoc.maxDiscount) {
        couponDiscount = couponDoc.maxDiscount;
      }
    } else if (couponDoc.type === 'fixed') {
      couponDiscount = Math.min(couponDoc.value || 0, base);
    }
  }
  couponDiscount = round2(couponDiscount);

  const discount = round2(bulkDiscount + couponDiscount);
  const total = round2(subtotal - discount);

  return {
    currency: ORDER_CURRENCY,
    totalQuantity,
    subtotal,
    bulkDiscountPercent,
    bulkDiscount,
    couponDiscount,
    discount,
    tax: 0,
    shipping: 0,
    total
  };
}

async function loadValidCoupon(code, subtotal) {
  if (!code) return null;

  const coupon = await couponsCollection.findOne({
    code: String(code).toUpperCase(),
    status: 'active'
  });

  if (!coupon) {
    const err = new Error('Invalid coupon code');
    err.status = 400;
    throw err;
  }

  const now = new Date();
  if (now < new Date(coupon.startDate) || now > new Date(coupon.endDate)) {
    const err = new Error('Coupon has expired');
    err.status = 400;
    throw err;
  }

  if (coupon.limit && coupon.usage >= coupon.limit) {
    const err = new Error('Coupon usage limit reached');
    err.status = 400;
    throw err;
  }

  if ((coupon.minOrder || 0) > subtotal) {
    const err = new Error(`Minimum order amount is ${coupon.minOrder}`);
    err.status = 400;
    throw err;
  }

  return coupon;
}

// Variant cell + global stock + soldCount একই atomic update-এ কমে।
// মাঝপথে কোনো item ব্যর্থ হলে আগের item-গুলোর stock ফেরত যায়।
async function decrementStock(items) {
  const done = [];

  try {
    for (const item of items) {
      const qty = Number(item.qty);

      const product = await productsCollection.findOne(
        { _id: new ObjectId(item.productId) },
        { projection: { inventory: 1, productName: 1 } }
      );

      if (!product) {
        const err = new Error(`Product not found: ${item.name}`);
        err.status = 400;
        throw err;
      }

      let result;

      if (hasInventory(product)) {
        const cell = findInventoryCell(product, item.color, item.size);
        if (!cell) {
          const err = new Error(`Color/size not available for ${item.name}`);
          err.status = 400;
          throw err;
        }

        result = await productsCollection.updateOne(
          {
            _id: product._id,
            inventory: {
              $elemMatch: {
                color: cell.color,
                sizes: { $elemMatch: { size: cell.size, stock: { $gte: qty } } }
              }
            }
          },
          {
            $inc: {
              'inventory.$[c].sizes.$[s].stock': -qty,
              stock: -qty,
              soldCount: qty
            },
            $set: { updatedAt: new Date() }
          },
          { arrayFilters: [{ 'c.color': cell.color }, { 's.size': cell.size }] }
        );
      } else {
        result = await productsCollection.updateOne(
          { _id: product._id, stock: { $gte: qty } },
          {
            $inc: { stock: -qty, soldCount: qty },
            $set: { updatedAt: new Date() }
          }
        );
      }

      if (result.modifiedCount === 0) {
        const err = new Error(`Insufficient stock for ${item.name}`);
        err.status = 400;
        throw err;
      }

      done.push(item);
    }
  } catch (err) {
    await restoreStock(done);
    throw err;
  }
}

// Stock ফেরত (refund / rollback)। কোনো item ব্যর্থ হলে থামে না, ব্যর্থ item-এর তালিকা ফেরত দেয়।
async function restoreStock(items) {
  const failed = [];

  for (const item of items || []) {
    try {
      const qty = Number(item.qty);

      const product = await productsCollection.findOne(
        { _id: new ObjectId(item.productId) },
        { projection: { inventory: 1 } }
      );

      if (!product) {
        failed.push(item);
        continue;
      }

      let result;

      if (hasInventory(product)) {
        const cell = findInventoryCell(product, item.color, item.size);
        if (!cell) {
          failed.push(item);
          continue;
        }

        result = await productsCollection.updateOne(
          { _id: product._id },
          {
            $inc: {
              'inventory.$[c].sizes.$[s].stock': qty,
              stock: qty,
              soldCount: -qty
            },
            $set: { updatedAt: new Date() }
          },
          { arrayFilters: [{ 'c.color': cell.color }, { 's.size': cell.size }] }
        );
      } else {
        result = await productsCollection.updateOne(
          { _id: product._id },
          {
            $inc: { stock: qty, soldCount: -qty },
            $set: { updatedAt: new Date() }
          }
        );
      }

      if (result.matchedCount === 0) failed.push(item);
    } catch (restoreErr) {
      console.error('Stock restore error:', item.productId, restoreErr.message);
      failed.push(item);
    }
  }

  if (failed.length > 0) {
    console.error('Stock restore failed for items:', failed.map((i) => i.productId));
  }

  return failed;
}

async function releaseCouponUsage(code) {
  if (!code) return;
  await couponsCollection.updateOne(
    { code: String(code).toUpperCase(), usage: { $gt: 0 } },
    { $inc: { usage: -1 }, $set: { updatedAt: new Date() } }
  );
}

// অপরিশোধিত অর্ডার cancel (customer ও admin দুজনের জন্য shared)।
// ownerEmail দিলে অর্ডারটি ওই customer-এর কি না যাচাই হয়।
async function cancelUnpaidOrder(orderId, { by, reason, allowedStatuses, ownerEmail }) {
  const order = await ordersCollection.findOne({ orderId });

  if (!order) {
    const err = new Error('Order not found');
    err.status = 404;
    throw err;
  }

  if (ownerEmail && String(order.customer?.email || '').toLowerCase() !== String(ownerEmail).toLowerCase()) {
    const err = new Error('You can only cancel your own order');
    err.status = 403;
    throw err;
  }

  if (order.payment?.status === 'paid') {
    const err = new Error('This order is already paid. Please request a refund instead.');
    err.status = 400;
    throw err;
  }

  if (order.payment?.status !== 'pending' || !allowedStatuses.includes(order.status)) {
    const err = new Error(`Order cannot be cancelled in its current state (${order.status})`);
    err.status = 400;
    throw err;
  }

  const isStripe = order.payment?.method === 'stripe';

  // Stripe: checkout session বন্ধ করি, যাতে cancel-এর পরে কেউ পেমেন্ট করতে না পারে।
  // বন্ধ না হলে আর session paid কি না দেখি; paid হলে cancel হবে না।
  if (isStripe && order.payment?.stripeSessionId) {
    try {
      await stripe.checkout.sessions.expire(order.payment.stripeSessionId);
    } catch (expireErr) {
      try {
        const session = await stripe.checkout.sessions.retrieve(order.payment.stripeSessionId);
        if (session?.payment_status === 'paid') {
          const err = new Error('Payment was just received for this order. It cannot be cancelled.');
          err.status = 409;
          throw err;
        }
      } catch (checkErr) {
        if (checkErr.status === 409) throw checkErr;
        console.error('Stripe session check failed:', checkErr.message);
      }
    }
  }

  // Atomic: শুধু এখনো pending থাকলেই cancelled হবে (double cancel / race আটকায়)
  const claim = await ordersCollection.findOneAndUpdate(
    { orderId, status: { $in: allowedStatuses }, 'payment.status': 'pending' },
    {
      $set: {
        status: 'cancelled',
        'payment.status': 'cancelled',
        cancelledAt: new Date(),
        cancelledBy: by,
        cancelReason: reason,
        updatedAt: new Date()
      }
    },
    { returnDocument: 'after' }
  );

  const cancelled = unwrapFindOneAndUpdate(claim);

  if (!cancelled) {
    const err = new Error('Order state changed. Please refresh and try again.');
    err.status = 409;
    throw err;
  }

  // Offline (COD / bank deposit): অর্ডারের সময়ই stock ও coupon কমেছিল, তাই ফেরত
  if (!isStripe) {
    const failed = await restoreStock(cancelled.items);
    if (failed.length > 0) {
      await ordersCollection.updateOne(
        { orderId },
        { $set: { stockRestoreIssue: true, updatedAt: new Date() } }
      );
    }
    await releaseCouponUsage(cancelled.coupon?.code);
  }

  return cancelled;
}

async function bumpCouponUsage(code) {
  if (!code) return;
  await couponsCollection.updateOne(
    { code: String(code).toUpperCase() },
    { $inc: { usage: 1 }, $set: { updatedAt: new Date() } }
  );
}

async function createOfflineOrder({ req, paymentMethod, items, couponCode, shippingAddress }) {
  const customerEmail = (req.tokenEmail || '').toLowerCase();
  const userId = customerEmail;

  const pricedItems = await priceCartItems(items);
  validateMoq(pricedItems);

  const subtotal = pricedItems.reduce((sum, item) => sum + (item.price * item.qty), 0);
  const couponDoc = await loadValidCoupon(couponCode, subtotal);
  const pricing = computeOrderTotals(pricedItems, couponDoc);

  // coupon থেকে সত্যিই ছাড় না পেলে (যেমন free_shipping) coupon সংরক্ষণ বা usage গণনা নয়
  const appliedCoupon = couponDoc && pricing.couponDiscount > 0 ? couponDoc : null;

  const user = await usersCollection.findOne({ email: customerEmail });
  const orderId = `ORD-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;

  const orderData = {
    orderId,
    userId,
    customer: {
      email: customerEmail,
      name: user?.displayName || 'Guest',
      phone: shippingAddress?.phone || user?.phoneNumber || '',
      address: shippingAddress || user?.address || {}
    },
    items: pricedItems,
    currency: ORDER_CURRENCY,
    pricing,
    payment: {
      method: paymentMethod,
      status: 'pending',
    },
    status: 'pending',
    createdAt: new Date(),
    updatedAt: new Date()
  };

  if (appliedCoupon) {
    orderData.coupon = {
      code: appliedCoupon.code,
      type: appliedCoupon.type,
      value: appliedCoupon.value || 0,
      discount: pricing.couponDiscount
    };
  }

  await decrementStock(pricedItems);

  try {
    await ordersCollection.insertOne(orderData);
  } catch (insertErr) {
    await restoreStock(pricedItems);
    throw insertErr;
  }

  await cartsCollection.updateOne(
    { userId },
    { $set: { items: [], updatedAt: new Date() } }
  );
  await bumpCouponUsage(appliedCoupon?.code);

  return orderData;
}

function unwrapFindOneAndUpdate(result) {
  if (!result) return null;
  if (Object.prototype.hasOwnProperty.call(result, 'value')) return result.value;
  return result;
}

async function fulfillPaidOrder(orderId, extraPaymentFields = {}) {
  const result = await ordersCollection.findOneAndUpdate(
    { orderId, 'payment.status': 'pending' },
    {
      $set: {
        'payment.status': 'paid',
        status: 'processing',
        updatedAt: new Date(),
        ...extraPaymentFields
      }
    },
    { returnDocument: 'after' }
  );

  const order = unwrapFindOneAndUpdate(result);
  if (!order) return null;

  if (order.userId) {
    await cartsCollection.updateOne(
      { userId: order.userId },
      { $set: { items: [], updatedAt: new Date() } }
    );
  }

  if (order.items?.length) {
    try {
      await decrementStock(order.items);
    } catch (stockErr) {
      console.error('Stock decrement failed after payment:', orderId, stockErr.message);
      await ordersCollection.updateOne(
        { orderId },
        { $set: { stockIssue: stockErr.message, updatedAt: new Date() } }
      );
    }
  }

  await bumpCouponUsage(order.coupon?.code);
  return order;
}

// ============================================
// ADD THESE TEST ROUTES TO YOUR index.js
// Place them after your middleware setup
// ============================================

// 🧪 TEST ROUTE 1: Check if token is received
app.get("/api/test/token", blockTestInProd, async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    
    console.log('\n🧪 TOKEN TEST ROUTE HIT');
    console.log('Authorization Header:', authHeader);
    console.log('Headers:', JSON.stringify(req.headers, null, 2));
    
    if (!authHeader) {
      return res.status(401).json({
        success: false,
        message: 'No authorization header found',
        headers: req.headers
      });
    }
    
    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'Invalid authorization format. Expected: Bearer <token>',
        received: authHeader.substring(0, 50) + '...'
      });
    }
    
    const token = authHeader.split(' ')[1];
    
    res.json({
      success: true,
      message: 'Token received successfully!',
      tokenLength: token.length,
      tokenPreview: token.substring(0, 50) + '...'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Test route error',
      error: error.message
    });
  }
});

// 🧪 TEST ROUTE 2: Check Firebase token verification
app.get("/api/test/verify-token", blockTestInProd, verifyFirebaseToken, async (req, res) => {
  try {
    console.log('\n🧪 TOKEN VERIFICATION TEST');
    console.log('Token verified successfully!');
    console.log('User UID:', req.uid);
    console.log('User Email:', req.tokenEmail);
    
    res.json({
      success: true,
      message: 'Token verified successfully!',
      user: {
        uid: req.uid,
        email: req.tokenEmail,
        emailVerified: req.emailVerified
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Verification test error',
      error: error.message
    });
  }
});

// 🧪 TEST ROUTE 3: Check admin access
app.get("/api/test/admin", blockTestInProd, verifyFirebaseToken, verifyAdmin, async (req, res) => {
  try {
    console.log('\n🧪 ADMIN ACCESS TEST');
    console.log('Admin verified!');
    console.log('Admin user:', req.user);
    
    res.json({
      success: true,
      message: 'Admin access verified!',
      user: req.user
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Admin test error',
      error: error.message
    });
  }
});

// 🧪 TEST ROUTE 4: Simple product test (no auth)
app.get("/api/test/products", blockTestInProd, async (req, res) => {
  try {
    const count = await productsCollection.countDocuments();
    const sample = await productsCollection.findOne();
    
    res.json({
      success: true,
      message: 'Database connection OK',
      totalProducts: count,
      sampleProduct: sample ? {
        id: sample._id,
        name: sample.productName,
        sku: sample.sku
      } : null
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Database test error',
      error: error.message
    });
  }
});

// 🧪 TEST ROUTE 5: Test product delete (with auth)
app.delete("/api/test/products/:id", blockTestInProd, verifyFirebaseToken, verifyAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    
    console.log('\n🧪 DELETE TEST');
    console.log('Product ID:', id);
    console.log('User:', req.tokenEmail);
    console.log('Admin:', req.user.role);
    
    // Don't actually delete, just check if we can
    const product = await productsCollection.findOne({ _id: new ObjectId(id) });
    
    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }
    
    res.json({
      success: true,
      message: 'Delete would work! (Not actually deleted in test)',
      product: {
        id: product._id,
        name: product.productName
      }
    });
  } catch (error) {
    console.error('Delete test error:', error);
    res.status(500).json({
      success: false,
      message: 'Delete test error',
      error: error.message
    });
  }
});


// ============================================
// HANDLE SUCCESSFUL PAYMENT FUNCTION
// ============================================
async function handleSuccessfulPayment(session) {
  console.log('\n🔄 Starting handleSuccessfulPayment...');
  
  try {
    const orderId = session.client_reference_id;
    const paymentIntentId = session.payment_intent;

    console.log('📋 Processing Order:', orderId);
    console.log('💳 Payment Intent:', paymentIntentId);

    if (!orderId) {
      console.error('❌ No order ID in session');
      return;
    }

    const extraPaymentFields = {
      'payment.stripePaymentIntentId': paymentIntentId || null,
      'payment.paidAt': new Date()
    };

    if (paymentIntentId) {
      const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
      extraPaymentFields['payment.transactionId'] = paymentIntent.id;
      extraPaymentFields['payment.amount'] = paymentIntent.amount / 100;
      extraPaymentFields['payment.currency'] = paymentIntent.currency;
    }

    const order = await fulfillPaidOrder(orderId, extraPaymentFields);
    if (!order) {
      console.log('⚠️ Order already fulfilled or not pending:', orderId);
      return;
    }

    console.log('🎉 Payment processing complete!\n');
  } catch (error) {
    console.error('❌ ERROR in handleSuccessfulPayment:');
    console.error('   Message:', error.message);
    console.error('   Stack:', error.stack);
    throw error;
  }
}


// MongoDB connection
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.hs9qs.mongodb.net/?retryWrites=true&w=majority`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
  serverSelectionTimeoutMS: 10000, // 10 seconds
  socketTimeoutMS: 45000,
});



async function run() {
  try {
    await client.connect();

    const database = client.db("eCommerceDB");

    // Collections
    productsCollection = database.collection("products");
    cartsCollection = database.collection("carts");
    wishlistsCollection = database.collection("wishlists")
    usersCollection = database.collection("users")
    ordersCollection = database.collection("orders");
    couponsCollection = database.collection("coupons");
    addressesCollection = database.collection("addresses");
    countersCollection = database.collection("counters");

    console.log("All collections initialized");

        // SKU database level-এও unique (দুটো request একসঙ্গে এলে race আটকায়)
    try {
      await productsCollection.createIndex(
        { sku: 1 },
        { unique: true, name: 'sku_unique' }
      );
    } catch (indexError) {
      console.error('SKU index creation failed:', indexError.message);
    }

    // ============================================
    // JWT VERIFICATION MIDDLEWARE
    // ============================================
    // function verifyJWT(req, res, next) {
    //   const authHeader = req.headers.authorization;
    //   if (!authHeader) {
    //     return res.status(401).send({ error: "Unauthorized access" });
    //   }

    //   const token = authHeader.split(" ")[1];

    //   jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    //     if (err) {
    //       return res.status(403).send({ error: "Forbidden access" });
    //     }
    //     req.decoded = decoded;
    //     next();
    //   });
    // }

    // JWT TOKEN GENERATION ROUTE
    // app.post("/jwt", (req, res) => {
    //   const user = req.body;
    //   const token = jwt.sign(user, process.env.JWT_SECRET, {
    //     expiresIn: "7d",
    //   });
    //   res.send({ token });
    // });

    // ============================================
    // ROUTES
    // ============================================

    // Health check
    app.get("/", (req, res) => {
      res.json({ 
        success: true,
        message: "E-Commerce Server is running",
        timestamp: new Date().toISOString()
      });
    });

app.post("/jwt", verifyFirebaseToken, (req, res) => {
  const token = jwt.sign(
    {
      email: req.tokenEmail,
    }, 
    process.env.JWT_ACCESS_SECRET, 
    {
      expiresIn: "7d",
    }
  );

  // Cookie settings
  res.cookie('access_token', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

  res.send({success: true});
});


    // ============================================
    // 🆕 USER MANAGEMENT ROUTES
    // ============================================

    // POST - Register or update user (called after Firebase auth)
    app.post("/api/users/register", verifyFirebaseToken, async (req, res) => {
      try {
        const { displayName, photoURL, emailVerified, provider } = req.body;
        const uid = req.uid;
        const email = (req.tokenEmail || '').toLowerCase();

        // Validate required fields
        if (!uid || !email) {
          return res.status(400).json({
            success: false,
            message: 'UID and email are required',
          });
        }

        // Check if user already exists
        let user = await usersCollection.findOne({ uid });

        if (user) {
          // Update existing user
          const updateData = {
            displayName: displayName || user.displayName,
            photoURL: photoURL || user.photoURL,
            emailVerified: emailVerified !== undefined ? emailVerified : user.emailVerified,
            lastLogin: new Date(),
            updatedAt: new Date()
          };

          await usersCollection.updateOne(
            { uid },
            { $set: updateData }
          );

          const updatedUser = await usersCollection.findOne({ uid });

          return res.status(200).json({
            success: true,
            message: 'User updated successfully',
            user: updatedUser,
          });
        }

        // Create new user
        const newUser = {
          uid,
          email: email.toLowerCase(),
          displayName: displayName || email.split('@')[0],
          photoURL: photoURL || '',
          emailVerified: emailVerified || false,
          provider: provider || 'password',
          role: 'user',  // Default role
          phoneNumber: '',
          address: {
            street: '',
            city: '',
            state: '',
            zipCode: '',
            country: ''
          },
          isActive: true,
          lastLogin: new Date(),
          preferences: {
            newsletter: false,
            notifications: true
          },
          createdAt: new Date(),
          updatedAt: new Date()
        };

        await usersCollection.insertOne(newUser);

        res.status(201).json({
          success: true,
          message: 'User registered successfully',
          user: newUser,
        });
      } catch (error) {
        console.error('Register user error:', error);
        
        if (error.code === 11000) {
          return res.status(400).json({
            success: false,
            message: 'User already exists with this email or UID',
          });
        }

        res.status(500).json({
          success: false,
          message: 'Failed to register user',
          error: error.message,
        });
      }
    });

    // GET - Get user profile with order history
    app.get("/api/users/profile/full", verifyFirebaseToken, async (req, res) => {
      try {
        const user = await usersCollection.findOne({ uid: req.uid });
      
        if (!user) {
          return res.status(404).json({
            success: false,
            message: 'User not found',
          });
        }
      
        // Initialize default values
        let recentOrders = [];
        let ordersCount = 0;

        // Try to get orders (orders collection may not exist yet)
        try {
          recentOrders = await ordersCollection
            .find({ 
              $or: [
                { userId: user.uid },
                { 'customer.email': user.email }
              ]
            })
            .sort({ createdAt: -1 })
            .limit(10)
            .toArray();
          
          ordersCount = await ordersCollection.countDocuments({
            $or: [
              { userId: user.uid },
              { 'customer.email': user.email }
            ]
          });
        } catch (orderError) {
          console.log('Orders collection not found or empty:', orderError.message);
          // Continue with empty orders
        }
      
        // Get wishlist count
        let wishlistCount = 0;
        try {
          wishlistCount = await wishlistsCollection.countDocuments({
            userId: user.email
          });
        } catch (wishlistError) {
          console.log('Wishlist error:', wishlistError.message);
        }
      
        // Update last login
        await usersCollection.updateOne(
          { uid: req.uid },
          { $set: { lastLogin: new Date() } }
        );
      
        res.status(200).json({
          success: true,
          user: {
            ...user,
            recentOrders: recentOrders,
            wishlistCount: wishlistCount,
            ordersCount: ordersCount
          },
        });
      } catch (error) {
        console.error('Get full profile error:', error);
        res.status(500).json({
          success: false,
          message: 'Failed to fetch user profile',
          error: error.message,
        });
      }
    });

    // PATCH - Update user profile
    app.patch("/api/users/profile", verifyFirebaseToken, async (req, res) => {
      try {
        const { displayName, photoURL, phoneNumber, address, preferences } = req.body;

        const user = await usersCollection.findOne({ uid: req.uid });

        if (!user) {
          return res.status(404).json({
            success: false,
            message: 'User not found',
          });
        }

        // Build update object
        const updateData = { updatedAt: new Date() };
        
        if (displayName) updateData.displayName = displayName;
        if (photoURL) updateData.photoURL = photoURL;
        if (phoneNumber) updateData.phoneNumber = phoneNumber;
        if (address) updateData.address = { ...user.address, ...address };
        if (preferences) updateData.preferences = { ...user.preferences, ...preferences };

        await usersCollection.updateOne(
          { uid: req.uid },
          { $set: updateData }
        );

        const updatedUser = await usersCollection.findOne({ uid: req.uid });

        res.status(200).json({
          success: true,
          message: 'Profile updated successfully',
          user: updatedUser,
        });
      } catch (error) {
        console.error('Update profile error:', error);
        res.status(500).json({
          success: false,
          message: 'Failed to update profile',
          error: error.message,
        });
      }
    });

    // GET - Get user role by email (for frontend role checking)
    app.get("/api/users/role/:email", verifyFirebaseToken, async (req, res) => {
      try {
        const { email } = req.params;

        if (!email) {
          return res.status(400).json({
            success: false,
            message: 'Email is required',
          });
        }

        const requested = email.toLowerCase();
        const requester = (req.tokenEmail || '').toLowerCase();
        if (requested !== requester) {
          const requesterUser = await usersCollection.findOne({ email: requester });
          if (!requesterUser || !['admin', 'staff', 'manager'].includes(requesterUser.role)) {
            return res.status(403).json({
              success: false,
              message: 'Forbidden'
            });
          }
        }

        const user = await usersCollection.findOne({ 
          email: requested 
        });

        if (!user) {
          return res.status(404).json({
            success: false,
            message: 'User not found',
          });
        }

        res.status(200).json({
          success: true,
          role: user.role,
        });
      } catch (error) {
        console.error('Get user role error:', error);
        res.status(500).json({
          success: false,
          message: 'Failed to fetch user role',
          error: error.message,
        });
      }
    });

    // GET - Get all users (Admin only)
    app.get("/api/users", verifyFirebaseToken, verifyAdmin, async (req, res) => {
      try {
        const { page = 1, limit = 10, role, search } = req.query;

        const query = {};
        
        if (role) query.role = role;
        if (search) {
          query.$or = [
            { displayName: { $regex: search, $options: 'i' } },
            { email: { $regex: search, $options: 'i' } },
          ];
        }

        const users = await usersCollection.find(query)
          .limit(limit * 1)
          .skip((page - 1) * limit)
          .sort({ createdAt: -1 })
          .toArray();

        const count = await usersCollection.countDocuments(query);

        res.status(200).json({
          success: true,
          users,
          totalPages: Math.ceil(count / limit),
          currentPage: parseInt(page),
          total: count,
        });
      } catch (error) {
        console.error('Get all users error:', error);
        res.status(500).json({
          success: false,
          message: 'Failed to fetch users',
          error: error.message,
        });
      }
    });

    // PATCH - Update user role (Admin only)
    app.patch("/api/users/:userId/role", verifyFirebaseToken, verifyAdmin, async (req, res) => {
      try {
        const { userId } = req.params;
        const { role } = req.body;

        if (!['user', 'admin', 'staff'].includes(role)) {
          return res.status(400).json({
            success: false,
            message: 'Invalid role. Must be user, admin, or staff',
          });
        }

        const result = await usersCollection.updateOne(
          { _id: new ObjectId(userId) },
          { 
            $set: { 
              role,
              updatedAt: new Date()
            } 
          }
        );

        if (result.matchedCount === 0) {
          return res.status(404).json({
            success: false,
            message: 'User not found',
          });
        }

        const updatedUser = await usersCollection.findOne({ 
          _id: new ObjectId(userId) 
        });

        res.status(200).json({
          success: true,
          message: 'User role updated successfully',
          user: updatedUser,
        });
      } catch (error) {
        console.error('Update user role error:', error);
        res.status(500).json({
          success: false,
          message: 'Failed to update user role',
          error: error.message,
        });
      }
    });

    // DELETE - Delete user (Admin only)
    app.delete("/api/users/:userId", verifyFirebaseToken, verifyAdmin, async (req, res) => {
      try {
        const { userId } = req.params;

        const user = await usersCollection.findOne({ 
          _id: new ObjectId(userId) 
        });

        if (!user) {
          return res.status(404).json({
            success: false,
            message: 'User not found',
          });
        }

        // Delete from Firebase Auth
        try {
          await admin.auth().deleteUser(user.uid);
        } catch (firebaseError) {
          console.error('Firebase deletion error:', firebaseError);
        }

        // Delete from database
        await usersCollection.deleteOne({ _id: new ObjectId(userId) });

        res.status(200).json({
          success: true,
          message: 'User deleted successfully',
        });
      } catch (error) {
        console.error('Delete user error:', error);
        res.status(500).json({
          success: false,
          message: 'Failed to delete user',
          error: error.message,
        });
      }
    });

    // ============================================
// USER STATISTICS (Admin Only)
// ============================================

// GET - Get user statistics
app.get("/api/admin/stats/users", verifyFirebaseToken, verifyAdmin, async (req, res) => {
  try {
    const totalUsers = await usersCollection.countDocuments();
    const adminCount = await usersCollection.countDocuments({ role: 'admin' });
    const staffCount = await usersCollection.countDocuments({ role: 'staff' });
    const regularUsers = await usersCollection.countDocuments({ role: 'user' });

    // Active users (logged in last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const activeUsers = await usersCollection.countDocuments({
      lastLogin: { $gte: thirtyDaysAgo }
    });

    // New users this month
    const firstDayOfMonth = new Date();
    firstDayOfMonth.setDate(1);
    firstDayOfMonth.setHours(0, 0, 0, 0);
    
    const newUsersThisMonth = await usersCollection.countDocuments({
      createdAt: { $gte: firstDayOfMonth }
    });

    res.status(200).json({
      success: true,
      stats: {
        totalUsers,
        adminCount,
        staffCount,
        regularUsers,
        activeUsers,
        newUsersThisMonth
      }
    });
  } catch (error) {
    console.error('Get user stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch user statistics',
      error: error.message,
    });
  }
});


// ROUTE 1: MAIN DASHBOARD STATS
// GET /api/admin/stats/dashboard
// Returns: revenue, orders, customers, products + growth %
// ============================================
app.get("/api/admin/stats/dashboard", verifyFirebaseToken, verifyAdmin, async (req, res) => {
  try {
    const now = new Date();
 
    // ── Date boundaries ──────────────────────────────────────────────
    const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endOfLastMonth   = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
 
    // ── Revenue ─────────────────────────────────────────────────────
    const revenueAgg = await ordersCollection.aggregate([
      { $match: { "payment.status": "paid" } },
      {
        $group: {
          _id: {
            month: { $month: "$createdAt" },
            year:  { $year:  "$createdAt" }
          },
          revenue: { $sum: "$pricing.total" }
        }
      }
    ]).toArray();
 
    const totalRevenue = revenueAgg.reduce((s, r) => s + r.revenue, 0);
 
    // This month vs last month revenue
    const thisMonthRevAgg = await ordersCollection.aggregate([
      { $match: { "payment.status": "paid", createdAt: { $gte: startOfThisMonth } } },
      { $group: { _id: null, revenue: { $sum: "$pricing.total" } } }
    ]).toArray();
 
    const lastMonthRevAgg = await ordersCollection.aggregate([
      { $match: { "payment.status": "paid", createdAt: { $gte: startOfLastMonth, $lte: endOfLastMonth } } },
      { $group: { _id: null, revenue: { $sum: "$pricing.total" } } }
    ]).toArray();
 
    const thisMonthRevenue = thisMonthRevAgg[0]?.revenue || 0;
    const lastMonthRevenue = lastMonthRevAgg[0]?.revenue || 0;
    const revenueGrowth = lastMonthRevenue === 0
      ? (thisMonthRevenue > 0 ? 100 : 0)
      : parseFloat((((thisMonthRevenue - lastMonthRevenue) / lastMonthRevenue) * 100).toFixed(1));
 
    // ── Orders ───────────────────────────────────────────────────────
    const totalOrders     = await ordersCollection.countDocuments();
    const thisMonthOrders = await ordersCollection.countDocuments({ createdAt: { $gte: startOfThisMonth } });
    const lastMonthOrders = await ordersCollection.countDocuments({ createdAt: { $gte: startOfLastMonth, $lte: endOfLastMonth } });
    const ordersGrowth    = lastMonthOrders === 0
      ? (thisMonthOrders > 0 ? 100 : 0)
      : parseFloat((((thisMonthOrders - lastMonthOrders) / lastMonthOrders) * 100).toFixed(1));
 
    // ── Customers ────────────────────────────────────────────────────
    const totalCustomers     = await usersCollection.countDocuments();
    const thisMonthCustomers = await usersCollection.countDocuments({ createdAt: { $gte: startOfThisMonth } });
    const lastMonthCustomers = await usersCollection.countDocuments({ createdAt: { $gte: startOfLastMonth, $lte: endOfLastMonth } });
    const customersGrowth    = lastMonthCustomers === 0
      ? (thisMonthCustomers > 0 ? 100 : 0)
      : parseFloat((((thisMonthCustomers - lastMonthCustomers) / lastMonthCustomers) * 100).toFixed(1));
 
    // ── Products ─────────────────────────────────────────────────────
    const totalProducts = await productsCollection.countDocuments();
    const thisMonthProducts = await productsCollection.countDocuments({ createdAt: { $gte: startOfThisMonth } });
    const lastMonthProducts = await productsCollection.countDocuments({ createdAt: { $gte: startOfLastMonth, $lte: endOfLastMonth } });
    const productsGrowth    = lastMonthProducts === 0
      ? (thisMonthProducts > 0 ? 100 : 0)
      : parseFloat((((thisMonthProducts - lastMonthProducts) / lastMonthProducts) * 100).toFixed(1));
 
    // ── Recent Orders (last 5) ────────────────────────────────────────
    const recentOrders = await ordersCollection
      .find({})
      .sort({ createdAt: -1 })
      .limit(5)
      .toArray();
 
    res.json({
      success: true,
      stats: {
        totalRevenue,
        revenueGrowth,
        thisMonthRevenue,
        totalOrders,
        ordersGrowth,
        thisMonthOrders,
        totalCustomers,
        customersGrowth,
        thisMonthCustomers,
        totalProducts,
        productsGrowth,
        thisMonthProducts
      },
      recentOrders
    });
  } catch (error) {
    console.error("Dashboard stats error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch dashboard stats", error: error.message });
  }
});

// ============================================
// COD ORDER ROUTE
// ============================================
app.post("/api/orders/cod", verifyFirebaseToken, async (req, res) => {
  try {
    const { items, coupon, shippingAddress } = req.body;
    const orderData = await createOfflineOrder({
      req,
      paymentMethod: 'cod',
      items,
      couponCode: coupon?.code,
      shippingAddress
    });

    res.status(201).json({
      success: true,
      message: 'Order placed successfully',
      orderId: orderData.orderId,
      order: orderData
    });
  } catch (error) {
    console.error('COD order error:', error);
    res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Failed to place order'
    });
  }
});

app.post("/api/orders/bank-deposit", verifyFirebaseToken, async (req, res) => {
  try {
    const { items, coupon, shippingAddress } = req.body;
    const orderData = await createOfflineOrder({
      req,
      paymentMethod: 'bank_deposit',
      items,
      couponCode: coupon?.code,
      shippingAddress
    });

    res.status(201).json({
      success: true,
      message: 'Order placed. Pay via bank deposit and share the receipt on WhatsApp.',
      orderId: orderData.orderId,
      order: orderData
    });
  } catch (error) {
    console.error('Bank deposit order error:', error);
    res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Failed to place order'
    });
  }
});


// ============================================
// ROUTE 2: REVENUE CHART DATA (Last 12 months)
// GET /api/admin/stats/revenue-chart
// ============================================
app.get("/api/admin/stats/revenue-chart", verifyFirebaseToken, verifyAdmin, async (req, res) => {
  try {
    const now = new Date();
    // Go back 11 months from current month
    const twelveMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 11, 1);
 
    const rawData = await ordersCollection.aggregate([
      {
        $match: {
          "payment.status": "paid",
          createdAt: { $gte: twelveMonthsAgo }
        }
      },
      {
        $group: {
          _id: {
            year:  { $year:  "$createdAt" },
            month: { $month: "$createdAt" }
          },
          revenue: { $sum: "$pricing.total" },
          orders:  { $sum: 1 }
        }
      },
      { $sort: { "_id.year": 1, "_id.month": 1 } }
    ]).toArray();
 
    // Build a full 12-month array (fill zeros for months with no data)
    const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const chartData = [];
 
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const year  = d.getFullYear();
      const month = d.getMonth() + 1; // 1-based
 
      const found = rawData.find(r => r._id.year === year && r._id.month === month);
 
      chartData.push({
        month:   monthNames[d.getMonth()],
        year,
        revenue: found ? parseFloat(found.revenue.toFixed(2)) : 0,
        orders:  found ? found.orders : 0
      });
    }
 
    res.json({ success: true, chartData });
  } catch (error) {
    console.error("Revenue chart error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch chart data", error: error.message });
  }
});


// ============================================
// ROUTE 3: TOP PRODUCTS BY REVENUE & SALES
// GET /api/admin/stats/top-products
// ============================================
app.get("/api/admin/stats/top-products", verifyFirebaseToken, verifyAdmin, async (req, res) => {
  try {
    // Aggregate from paid orders → unwind items → group by productId
    const topProducts = await ordersCollection.aggregate([
      { $match: { "payment.status": "paid" } },
      { $unwind: "$items" },
      {
        $group: {
          _id:     "$items.productId",
          name:    { $first: "$items.name" },
          image:   { $first: "$items.image" },
          sales:   { $sum: "$items.qty" },
          revenue: { $sum: { $multiply: ["$items.price", "$items.qty"] } }
        }
      },
      { $sort: { revenue: -1 } },
      { $limit: 5 },
      {
        $lookup: {
          from:         "products",
          let:          { pid: "$_id" },
          pipeline: [
            { $match: { $expr: { $eq: [{ $toString: "$_id" }, "$$pid"] } } },
            { $project: { productName: 1, images: 1, media: 1 } }
          ],
          as: "productInfo"
        }
      },
      {
        $project: {
          _id:     0,
          productId: "$_id",
          name:    { $ifNull: [{ $arrayElemAt: ["$productInfo.productName", 0] }, "$name"] },
          image: {
            $ifNull: [
              { $arrayElemAt: [{ $arrayElemAt: ["$productInfo.media.images.url", 0] }, 0] },
              { $arrayElemAt: [{ $arrayElemAt: ["$productInfo.images.url", 0] }, 0] },
              "$image"
            ]
          },
          sales:   1,
          revenue: { $round: ["$revenue", 2] }
        }
      }
    ]).toArray();
 
    res.json({ success: true, topProducts });
  } catch (error) {
    console.error("Top products error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch top products", error: error.message });
  }
});



// ============================================
// BATCH UPDATE USER ROLES (Admin Only)
// ============================================

// POST - Batch update user roles
app.post("/api/admin/users/batch-role", verifyFirebaseToken, verifyAdmin, async (req, res) => {
  try {
    const { userIds, role } = req.body;

    if (!Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'User IDs array is required'
      });
    }

    if (!['user', 'admin', 'staff'].includes(role)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid role. Must be user, admin, or staff'
      });
    }

    const objectIds = userIds.map(id => new ObjectId(id));

    const result = await usersCollection.updateMany(
      { _id: { $in: objectIds } },
      { 
        $set: { 
          role,
          updatedAt: new Date()
        } 
      }
    );

    res.status(200).json({
      success: true,
      message: `${result.modifiedCount} users updated successfully`,
      modifiedCount: result.modifiedCount
    });
  } catch (error) {
    console.error('Batch role update error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update user roles',
      error: error.message,
    });
  }
});

    // ============================================
// EXAMPLE: STAFF PROTECTED ROUTE
// ============================================

// GET - Get all orders (Staff/Admin can access)
app.get("/api/orders", verifyFirebaseToken, verifyStaff, async (req, res) => {
  try {
    const { status, payment, search } = req.query;
    const pageNum = Math.max(1, parseInt(req.query.page) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(req.query.limit) || 10));

    const query = {};

    if (status) query.status = String(status);
    if (payment) query['payment.status'] = String(payment);
    if (search) {
      const s = escapeRegex(String(search).slice(0, 100));
      query.$or = [
        { orderId: { $regex: s, $options: 'i' } },
        { 'customer.email': { $regex: s, $options: 'i' } },
        { 'customer.name': { $regex: s, $options: 'i' } },
        { 'customer.address.fullName': { $regex: s, $options: 'i' } },
      ];
    }

    const orders = await ordersCollection
      .find(query)
      .sort({ createdAt: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .toArray();

    const count = await ordersCollection.countDocuments(query);
    const totalPages = Math.ceil(count / limitNum);

    res.status(200).json({
      success: true,
      orders,
      // পুরোনো ফিল্ড (অন্য পেজের জন্য)
      totalPages,
      currentPage: pageNum,
      total: count,
      // হুকের জন্য
      pagination: { page: pageNum, limit: limitNum, total: count, totalPages },
    });
  } catch (error) {
    console.error('Get orders error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch orders',
      error: error.message,
    });
  }
});


// ============================================
// CUSTOMER MANAGEMENT API ROUTES
// ============================================

// ============================================
// UPDATED CUSTOMER GET ROUTE WITH ADVANCED SORTING
// Replace your existing /api/customers GET route with this
// ============================================

app.get("/api/customers", verifyFirebaseToken, verifyStaff, async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 10, 
      status, 
      search,
      role,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

    // Build query
    const query = {};

    if (role && role !== 'all') {
      query.role = role;
    }
    
    if (status && status !== 'all') {
      query.isActive = status === 'active';
    }
    
    if (search) {
      query.$or = [
        { displayName: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { phoneNumber: { $regex: search, $options: 'i' } },
      ];
    }

    // 🔥 FIXED: Case-insensitive sorting for displayName
    let sortConfig = {};
    const order = sortOrder === 'desc' ? -1 : 1;

    // Only use database sorting for date fields
    if (sortBy === 'createdAt' || sortBy === 'lastLogin') {
      sortConfig = { [sortBy]: order };
    } else {
      // For other fields, we'll sort in memory after calculating stats
      sortConfig = { createdAt: -1 }; // Default sort
    }

    // Execute query with pagination
    const customers = await usersCollection
      .find(query)
      .sort(sortConfig)
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .toArray();

    const count = await usersCollection.countDocuments(query);

    // Calculate statistics for each customer
    const customersWithStats = await Promise.all(
      customers.map(async (customer) => {
        const orderCount = await ordersCollection.countDocuments({
          $or: [
            { userId: customer.uid },
            { 'customer.email': customer.email }
          ]
        });

        const orders = await ordersCollection
          .find({
            $or: [
              { userId: customer.uid },
              { 'customer.email': customer.email }
            ]
          })
          .toArray();

        const totalSpent = orders.reduce((sum, order) => {
          return sum + (order.pricing?.total || 0);
        }, 0);

        const lastOrder = orders.length > 0 
          ? orders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0]
          : null;

        return {
          ...customer,
          stats: {
            orderCount,
            totalSpent,
            lastOrderDate: lastOrder?.createdAt || null,
            averageOrderValue: orderCount > 0 ? totalSpent / orderCount : 0
          }
        };
      })
    );

    //Case-insensitive in-memory sorting
    if (sortBy === 'displayName') {
      customersWithStats.sort((a, b) => {
        const nameA = (a.displayName || '').toLowerCase();
        const nameB = (b.displayName || '').toLowerCase();
        
        if (order === 1) { // Ascending
          return nameA.localeCompare(nameB);
        } else { // Descending
          return nameB.localeCompare(nameA);
        }
      });
    } else if (sortBy === 'totalSpent') {
      customersWithStats.sort((a, b) => {
        const aSpent = a.stats?.totalSpent || 0;
        const bSpent = b.stats?.totalSpent || 0;
        return order === 1 ? aSpent - bSpent : bSpent - aSpent;
      });
    } else if (sortBy === 'orderCount') {
      customersWithStats.sort((a, b) => {
        const aCount = a.stats?.orderCount || 0;
        const bCount = b.stats?.orderCount || 0;
        return order === 1 ? aCount - bCount : bCount - aCount;
      });
    }

    res.status(200).json({
      success: true,
      customers: customersWithStats,
      pagination: {
        total: count,
        totalPages: Math.ceil(count / limit),
        currentPage: parseInt(page),
        limit: parseInt(limit)
      }
    });

  } catch (error) {
    console.error('Get customers error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch customers',
      error: error.message,
    });
  }
});

// GET - Get single customer details (Admin/Staff)
app.get("/api/customers/:customerId", verifyFirebaseToken, verifyStaff, async (req, res) => {
  try {
    const { customerId } = req.params;

    // Find customer by _id or uid
    const customer = await usersCollection.findOne({
      $or: [
        { _id: new ObjectId(customerId) },
        { uid: customerId }
      ]
    });

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: 'Customer not found',
      });
    }

    // Get customer orders
    const orders = await ordersCollection
      .find({
        $or: [
          { userId: customer.uid },
          { 'customer.email': customer.email }
        ]
      })
      .sort({ createdAt: -1 })
      .toArray();

    // Calculate stats
    const totalSpent = orders.reduce((sum, order) => {
      return sum + (order.pricing?.total || 0);
    }, 0);

    const completedOrders = orders.filter(o => o.status === 'delivered').length;
    const pendingOrders = orders.filter(o => ['pending', 'processing'].includes(o.status)).length;

    // Get wishlist count
    const wishlistCount = await wishlistsCollection.countDocuments({
      userId: customer.email
    });

    res.status(200).json({
      success: true,
      customer: {
        ...customer,
        stats: {
          totalOrders: orders.length,
          completedOrders,
          pendingOrders,
          totalSpent,
          averageOrderValue: orders.length > 0 ? totalSpent / orders.length : 0,
          wishlistCount
        },
        recentOrders: orders.slice(0, 5)
      }
    });

  } catch (error) {
    console.error('Get customer details error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch customer details',
      error: error.message,
    });
  }
});

// PATCH - Update customer status (Admin only)
app.patch("/api/customers/:customerId/status", verifyFirebaseToken, verifyAdmin, async (req, res) => {
  try {
    const { customerId } = req.params;
    const { isActive } = req.body;

    if (typeof isActive !== 'boolean') {
      return res.status(400).json({
        success: false,
        message: 'Invalid status value. Must be boolean.',
      });
    }

    const result = await usersCollection.updateOne(
      { $or: [{ _id: new ObjectId(customerId) }, { uid: customerId }] },
      { 
        $set: { 
          isActive,
          updatedAt: new Date()
        } 
      }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'Customer not found',
      });
    }

    const updatedCustomer = await usersCollection.findOne({
      $or: [{ _id: new ObjectId(customerId) }, { uid: customerId }]
    });

    res.status(200).json({
      success: true,
      message: `Customer ${isActive ? 'activated' : 'deactivated'} successfully`,
      customer: updatedCustomer,
    });

  } catch (error) {
    console.error('Update customer status error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update customer status',
      error: error.message,
    });
  }
});

// PATCH - Update customer details (Admin only)
app.patch("/api/customers/:customerId", verifyFirebaseToken, verifyAdmin, async (req, res) => {
  try {
    const { customerId } = req.params;
    const { displayName, phoneNumber, address, preferences } = req.body;

    const customer = await usersCollection.findOne({
      $or: [{ _id: new ObjectId(customerId) }, { uid: customerId }]
    });

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: 'Customer not found',
      });
    }

    // Build update object
    const updateData = { updatedAt: new Date() };
    
    if (displayName) updateData.displayName = displayName;
    if (phoneNumber) updateData.phoneNumber = phoneNumber;
    if (address) updateData.address = { ...customer.address, ...address };
    if (preferences) updateData.preferences = { ...customer.preferences, ...preferences };

    await usersCollection.updateOne(
      { $or: [{ _id: new ObjectId(customerId) }, { uid: customerId }] },
      { $set: updateData }
    );

    const updatedCustomer = await usersCollection.findOne({
      $or: [{ _id: new ObjectId(customerId) }, { uid: customerId }]
    });

    res.status(200).json({
      success: true,
      message: 'Customer updated successfully',
      customer: updatedCustomer,
    });

  } catch (error) {
    console.error('Update customer error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update customer',
      error: error.message,
    });
  }
});

// GET - Get customer statistics (Admin only)
app.get("/api/customers/stats/overview", verifyFirebaseToken, verifyAdmin, async (req, res) => {
  try {
    // 🔧 FIX: Update existing users without lastLogin
    await usersCollection.updateMany(
      { lastLogin: { $exists: false } },
      { $set: { lastLogin: new Date() } }
    );

    const totalCustomers = await usersCollection.countDocuments();
    const adminCount = await usersCollection.countDocuments({ role: 'admin' });
    const staffCount = await usersCollection.countDocuments({ role: 'staff' });
    const regularUsers = await usersCollection.countDocuments({ role: 'user' });

    // Active customers (based on isActive field AND recent login)
    const activeCustomers = await usersCollection.countDocuments({ 
      isActive: true 
    });
    
    const inactiveCustomers = await usersCollection.countDocuments({ 
      isActive: false 
    });
    
    // Recently active users (logged in last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const recentlyActiveUsers = await usersCollection.countDocuments({
      lastLogin: { $gte: thirtyDaysAgo }
    });

    // New users this month
    const firstDayOfMonth = new Date();
    firstDayOfMonth.setDate(1);
    firstDayOfMonth.setHours(0, 0, 0, 0);
    
    const newUsersThisMonth = await usersCollection.countDocuments({
      createdAt: { $gte: firstDayOfMonth }
    });

    // ❌ BEFORE (Using distinct - not supported in API v1)
    // const customersWithOrders = await ordersCollection.distinct('customer.email');

    // ✅ AFTER (Using aggregation - supported in API v1)
    const customersWithOrdersResult = await ordersCollection.aggregate([
      {
        $group: {
          _id: '$customer.email'
        }
      },
      {
        $count: 'total'
      }
    ]).toArray();

    const customersWithOrders = customersWithOrdersResult.length > 0 
      ? customersWithOrdersResult[0].total 
      : 0;

    // Top customers by spending
    const topCustomers = await ordersCollection.aggregate([
      {
        $match: { 'payment.status': 'paid' }
      },
      {
        $group: {
          _id: '$customer.email',
          totalSpent: { $sum: '$pricing.total' },
          orderCount: { $sum: 1 }
        }
      },
      {
        $sort: { totalSpent: -1 }
      },
      {
        $limit: 5
      }
    ]).toArray();

    res.status(200).json({
      success: true,
      stats: {
        totalCustomers,
        activeCustomers,
        inactiveCustomers,
        adminCount,
        staffCount,
        regularUsers,
        recentlyActiveUsers,
        newUsersThisMonth,
        customersWithOrders,
        topCustomers
      }
    });

  } catch (error) {
    console.error('Get customer stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch customer statistics',
      error: error.message,
    });
  }
});

// DELETE - Delete customer (Admin only)
app.delete("/api/customers/:customerId", verifyFirebaseToken, verifyAdmin, async (req, res) => {
  try {
    const { customerId } = req.params;

    const customer = await usersCollection.findOne({
      $or: [{ _id: new ObjectId(customerId) }, { uid: customerId }]
    });

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: 'Customer not found',
      });
    }

    // Check if customer has orders
    const orderCount = await ordersCollection.countDocuments({
      $or: [
        { userId: customer.uid },
        { 'customer.email': customer.email }
      ]
    });

    if (orderCount > 0) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete customer with existing orders. Deactivate instead.',
      });
    }

    // Delete from Firebase Auth
    try {
      await admin.auth().deleteUser(customer.uid);
    } catch (firebaseError) {
      console.error('Firebase deletion error:', firebaseError);
      // Continue with database deletion even if Firebase fails
    }

    // Delete from database
    await usersCollection.deleteOne({
      $or: [{ _id: new ObjectId(customerId) }, { uid: customerId }]
    });

    // Clean up related data
    await wishlistsCollection.deleteMany({ userId: customer.email });
    await cartsCollection.deleteMany({ userId: customer.email });

    res.status(200).json({
      success: true,
      message: 'Customer deleted successfully',
    });

  } catch (error) {
    console.error('Delete customer error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete customer',
      error: error.message,
    });
  }
});

// POST - Send message to customer (Admin/Staff)
app.post("/api/customers/:customerId/message", verifyFirebaseToken, verifyStaff, async (req, res) => {
  try {
    const { customerId } = req.params;
    const { subject, message } = req.body;

    if (!subject || !message) {
      return res.status(400).json({
        success: false,
        message: 'Subject and message are required',
      });
    }

    const customer = await usersCollection.findOne({
      $or: [{ _id: new ObjectId(customerId) }, { uid: customerId }]
    });

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: 'Customer not found',
      });
    }

    // TODO: Implement actual email sending logic here
    // For now, just return success
    console.log(`Sending message to ${customer.email}:`, { subject, message });

    res.status(200).json({
      success: true,
      message: 'Message sent successfully',
      recipient: customer.email
    });

  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send message',
      error: error.message,
    });
  }
});

// GET - Export customers data (Admin only)
app.get("/api/customers/export/csv", verifyFirebaseToken, verifyAdmin, async (req, res) => {
  try {
    const customers = await usersCollection.find({}).toArray();

    // Generate CSV
    const csvHeader = 'Name,Email,Phone,Role,Status,Join Date,Total Orders,Total Spent\n';
    
    const csvData = await Promise.all(
      customers.map(async (customer) => {
        const orderCount = await ordersCollection.countDocuments({
          $or: [
            { userId: customer.uid },
            { 'customer.email': customer.email }
          ]
        });

        const orders = await ordersCollection.find({
          $or: [
            { userId: customer.uid },
            { 'customer.email': customer.email }
          ]
        }).toArray();

        const totalSpent = orders.reduce((sum, order) => sum + (order.pricing?.total || 0), 0);

        return [
          customer.displayName || '',
          customer.email || '',
          customer.phoneNumber || '',
          customer.role || 'user',
          customer.isActive ? 'active' : 'inactive',
          customer.createdAt ? new Date(customer.createdAt).toLocaleDateString() : '',
          orderCount,
          totalSpent.toFixed(2)
        ].join(',');
      })
    );

    const csv = csvHeader + csvData.join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=customers-${Date.now()}.csv`);
    res.status(200).send(csv);

  } catch (error) {
    console.error('Export customers error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to export customers',
      error: error.message,
    });
  }
});


    // ============================================
    // PRODUCTS ROUTES
    // ============================================
        app.get("/products", async (req, res) => {
      try {
        const { category, minPrice, maxPrice, size, color, tag } = req.query;

        // Draft ও archived Storefront-এ দেখানো হয় না
        let query = { status: { $nin: ['draft', 'archived'] } };

        if (category) query.mainCategory = category;
        if (size) query.sizes = size;
        if (color) query.colors = color;
        if (tag) query.tags = tag;
        
        if (minPrice && maxPrice) {
          query.newPrice = { $gte: Number(minPrice), $lte: Number(maxPrice) };
        }

        const products = await productsCollection.find(query).toArray();
        res.send(products);
      } catch (err) {
        res.status(500).send({ error: "Failed to fetch products" });
      }
    });

    // Admin: সব product (draft সহ)
    app.get("/api/admin/products", verifyFirebaseToken, verifyAdmin, async (req, res) => {
      try {
        const products = await productsCollection
          .find({})
          .sort({ createdAt: -1 })
          .toArray();
        res.send(products);
      } catch (err) {
        res.status(500).send({ error: "Failed to fetch products" });
      }
    });

    app.get("/products/:id", async (req, res) => {
      try {
        const id = req.params.id;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ error: "Invalid product id" });
        }

        const product = await productsCollection.findOne({
          _id: new ObjectId(id),
          status: { $nin: ['draft', 'archived'] },
        });
        
        if (!product) {
          return res.status(404).send({ error: "Product not found" });
        }
        
        res.send(product);
      } catch (err) {
        res.status(500).send({ error: "Failed to fetch product" });
      }
    });


        // POST - Create new product
    app.post("/api/products", verifyFirebaseToken, verifyAdmin, async (req, res) => {
      try {
        const { errors, doc } = buildProductDocument(req.body || {});

        if (errors.length > 0) {
          return res.status(400).json({
            success: false,
            message: errors[0],
            errors
          });
        }

        // SKU uniqueness (case-insensitive)
        const duplicate = await productsCollection.findOne(
          { sku: { $regex: `^${escapeRegex(doc.sku)}$`, $options: 'i' } },
          { projection: { _id: 1 } }
        );

        if (duplicate) {
          return res.status(400).json({
            success: false,
            message: "Product with this SKU already exists"
          });
        }

        const now = new Date();
        const productData = { ...doc, soldCount: 0, createdAt: now, updatedAt: now };

        await productsCollection.insertOne(productData);

        res.status(201).json({
          success: true,
          message: "Product created successfully",
          product: productData
        });

      } catch (err) {
        if (err.code === 11000) {
          return res.status(400).json({
            success: false,
            message: "Product with this SKU already exists"
          });
        }

        console.error('Create product error:', err);
        res.status(500).json({ 
          success: false,
          message: "Error creating product", 
          error: err.message 
        });
      }
    });


        // PUT - Update product
    app.put("/api/products/:id", verifyFirebaseToken, verifyAdmin, async (req, res) => {
      try {
        const id = req.params.id;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({
            success: false,
            message: "Invalid product id"
          });
        }

        const existing = await productsCollection.findOne({ _id: new ObjectId(id) });

        if (!existing) {
          return res.status(404).json({ 
            success: false,
            message: "Product not found" 
          });
        }

        const { errors, doc } = buildProductDocument(req.body || {}, existing);

        if (errors.length > 0) {
          return res.status(400).json({
            success: false,
            message: errors[0],
            errors
          });
        }

        // SKU uniqueness: নিজের SKU বাদ
        const duplicate = await productsCollection.findOne(
          {
            sku: { $regex: `^${escapeRegex(doc.sku)}$`, $options: 'i' },
            _id: { $ne: new ObjectId(id) }
          },
          { projection: { _id: 1 } }
        );

        if (duplicate) {
          return res.status(400).json({
            success: false,
            message: "Product with this SKU already exists"
          });
        }

        await productsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { ...doc, updatedAt: new Date() } }
        );

        const updatedProduct = await productsCollection.findOne({ _id: new ObjectId(id) });

        res.json({
          success: true,
          message: "Product updated successfully",
          product: updatedProduct
        });

      } catch (err) {
        if (err.code === 11000) {
          return res.status(400).json({
            success: false,
            message: "Product with this SKU already exists"
          });
        }

        console.error('Update product error:', err);
        res.status(500).json({ 
          success: false,
          message: "Error updating product", 
          error: err.message 
        });
      }
    }); 


    // DELETE - Delete product with Cloudinary cleanup
        // DELETE - Delete product with Cloudinary cleanup (images + videos[] + legacy video)
    app.delete("/api/products/:id", verifyFirebaseToken, verifyAdmin, async (req, res) => {
      try {
        const id = req.params.id;

        const product = await productsCollection.findOne({ 
          _id: new ObjectId(id) 
        });

        if (!product) {
          return res.status(404).json({ 
            success: false,
            message: "Product not found" 
          });
        }

        // সব image ও video (legacy সহ), duplicate ছাড়া
        const assetsToDelete = collectProductMedia(product);

        // Delete from MongoDB first
        const deleteResult = await productsCollection.deleteOne({ 
          _id: new ObjectId(id) 
        });

        if (deleteResult.deletedCount === 0) {
          return res.status(500).json({ 
            success: false,
            message: "Failed to delete product from database" 
          });
        }

        // Cloudinary cleanup (background, response আটকাবে না)
        if (assetsToDelete.length > 0) {
          Promise.allSettled(
            assetsToDelete.map((asset) =>
              cloudinary.uploader.destroy(asset.publicId, {
                invalidate: true,
                resource_type: asset.resourceType
              })
            )
          ).then((results) => {
            results.forEach((outcome, index) => {
              const asset = assetsToDelete[index];
              if (outcome.status === 'fulfilled') {
                const status = outcome.value?.result;
                if (status !== 'ok' && status !== 'not found') {
                  console.error('Cloudinary cleanup unexpected result:', asset, status);
                }
              } else {
                console.error('Cloudinary cleanup failed:', asset, outcome.reason?.message);
              }
            });
          });
        }

        res.json({
          success: true,
          message: "Product deleted successfully",
          deletedId: id,
          mediaCleanupStarted: assetsToDelete.length
        });

      } catch (err) {
        console.error('Delete product error:', err);
        res.status(500).json({ 
          success: false,
          message: "Error deleting product", 
          error: err.message 
        });
      }
    });


    // PATCH - Update product status
    app.patch("/api/products/:id/status", verifyFirebaseToken, verifyAdmin, async (req, res) => {
      try {
        const id = req.params.id;
        const { status } = req.body;
        

        if (!['active', 'draft', 'archived'].includes(status)) {
          return res.status(400).json({ 
            success: false,
            message: "Invalid status value" 
          });
        }

        const result = await productsCollection.updateOne(
          { _id: new ObjectId(id) },
          { 
            $set: { 
              status: status,
              updatedAt: new Date()
            } 
          }
        );

        if (result.matchedCount === 0) {
          return res.status(404).json({ 
            success: false,
            message: "Product not found" 
          });
        }

        const updatedProduct = await productsCollection.findOne({ 
          _id: new ObjectId(id) 
        });

        res.json({
          success: true,
          message: "Product status updated successfully",
          product: updatedProduct
        });

      } catch (err) {
        res.status(500).json({ 
          success: false,
          message: "Error updating product status", 
          error: err.message 
        });
      }
    });


    // ============================================
    // CLOUDINARY DELETE ROUTES (ADD THESE)
    // ============================================

        // DELETE single image from Cloudinary
    app.delete("/api/cloudinary/delete/image", verifyFirebaseToken, verifyAdmin, (req, res) =>
      handleCloudinaryDelete(req, res, 'image')
    ); 

    // DELETE single video from Cloudinary
    app.delete("/api/cloudinary/delete/video", verifyFirebaseToken, verifyAdmin, (req, res) =>
      handleCloudinaryDelete(req, res, 'video')
    );

    // DELETE batch images
    app.post("/api/cloudinary/delete/batch", verifyFirebaseToken, verifyAdmin, async (req, res) => {
  try {
    const { publicIds } = req.body;

    if (!Array.isArray(publicIds) || publicIds.length === 0) {
      return res.status(400).json({ 
        success: false,
        message: "Public IDs array is required" 
      });
    }

    const result = await cloudinary.api.delete_resources(publicIds, {
      invalidate: true,
      resource_type: 'image'
    });
    
    const deletedCount = Object.keys(result.deleted).length;
    

    return res.json({ 
      success: true,
      message: `${deletedCount} images deleted successfully`,
      result: result,
      deletedCount: deletedCount,
      totalRequested: publicIds.length
    });

  } catch (err) {
    res.status(500).json({ 
      success: false,
      message: "Error batch deleting images",
      error: err.message 
    });
  }
    });




    // ============================================
    // CART ROUTES - FIXED (using cartsCollection directly)
    // ============================================

    // GET user cart

app.get("/api/cart/:userId", verifyFirebaseToken, verifyCartOwner, async (req, res) => {
  try {
    const userId = req.params.userId;
    const cart = await cartsCollection.findOne({ userId });

    res.json({ 
      success: true,
      items: cart?.items || [] 
    });
  } catch (err) {
    console.error("GET cart error:", err);
    res.status(500).json({ 
      success: false,
      error: "Failed to fetch cart",
      items: []
    });
  }
});

// POST/UPDATE full cart
app.post("/api/cart/:userId", verifyFirebaseToken, verifyCartOwner, async (req, res) => {
  try {
    const userId = req.params.userId;
    const items = req.body.items || [];
    
    console.log('💾 POST /api/cart/:userId - Saving cart');
    console.log('   User:', userId);
    console.log('   Items to save:', items.length);

    // Validate items
    const validItems = items.filter(item => 
      item.key && item.productId && item.qty > 0
    );

    console.log('   Valid items:', validItems.length);

    const result = await cartsCollection.updateOne(
      { userId },
      { 
        $set: { 
          items: validItems,
          updatedAt: new Date()
        } 
      },
      { upsert: true }
    );

    console.log('✅ Cart saved:', result.modifiedCount || result.upsertedCount ? 'Success' : 'No change');

    res.json({ 
      success: true, 
      items: validItems 
    });
  } catch (err) {
    console.error("❌ POST cart error:", err);
    res.status(500).json({ 
      success: false,
      error: "Failed to save cart" 
    });
  }
});

    // ADD single item
    app.post("/api/cart/:userId/add", verifyFirebaseToken, verifyCartOwner, async (req, res) => {
      try {
        const { userId } = req.params;
        const item = req.body;


        if (!item || !item.key || !item.productId || !item.qty) {
          return res.status(400).json({ 
            success: false,
            message: "Invalid cart item. Must have key, productId, and qty" 
          });
        }

        const cart = await cartsCollection.findOne({ userId });

        if (!cart) {
          await cartsCollection.insertOne({
            userId,
            items: [item],
            createdAt: new Date(),
            updatedAt: new Date(),
          });
          
          return res.json({ 
            success: true, 
            message: "Cart created and item added",
            items: [item]
          });
        }

        const existingIndex = cart.items.findIndex((i) => i.key === item.key);
        
        if (existingIndex !== -1) {
          cart.items[existingIndex].qty += item.qty;
        } else {
          cart.items.push(item);
        }

        await cartsCollection.updateOne(
          { userId },
          {
            $set: {
              items: cart.items,
              updatedAt: new Date(),
            },
          }
        );

        res.json({ 
          success: true, 
          message: "Item added to cart",
          items: cart.items
        });
      } catch (err) {
        res.status(500).json({ 
          success: false,
          message: "Cannot add item to cart" 
        });
      }
    });

    // UPDATE item quantity
    app.patch("/api/cart/:userId/update/:itemKey", verifyFirebaseToken, verifyCartOwner, async (req, res) => {
      try {
        const { userId, itemKey } = req.params;
        const { qty } = req.body;

        if (qty === undefined || qty < 0) {
          return res.status(400).json({ 
            success: false,
            message: "Invalid quantity" 
          });
        }

        const cart = await cartsCollection.findOne({ userId });

        if (!cart) {
          return res.status(404).json({ 
            success: false,
            message: "Cart not found" 
          });
        }

        const itemIndex = cart.items.findIndex(i => i.key === itemKey);
        
        if (itemIndex === -1) {
          return res.status(404).json({ 
            success: false,
            message: "Item not found in cart" 
          });
        }

        if (qty === 0) {
          cart.items.splice(itemIndex, 1);
        } else {
          cart.items[itemIndex].qty = qty;
        }

        await cartsCollection.updateOne(
          { userId },
          {
            $set: {
              items: cart.items,
              updatedAt: new Date(),
            },
          }
        );

        res.json({ 
          success: true, 
          message: "Cart updated",
          items: cart.items
        });
      } catch (err) {
        res.status(500).json({ 
          success: false,
          message: "Cannot update cart" 
        });
      }
    });

    // REMOVE item
    app.delete("/api/cart/:userId/remove/:itemKey", verifyFirebaseToken, verifyCartOwner, async (req, res) => {
      try {
        const { userId, itemKey } = req.params;
        
        const result = await cartsCollection.updateOne(
          { userId },
          {
            $pull: { items: { key: itemKey } },
            $set: { updatedAt: new Date() }
          }
        );

        if (result.modifiedCount === 0) {
          return res.status(404).json({ 
            success: false,
            message: "Item not found" 
          });
        }

        res.json({ 
          success: true, 
          message: "Item removed from cart" 
        });
      } catch (err) {
        res.status(500).json({ 
          success: false,
          message: "Cannot remove item from cart" 
        });
      }
    });

    // CLEAR cart
    app.delete("/api/cart/:userId/clear", verifyFirebaseToken, verifyCartOwner, async (req, res) => {
      try {
        const { userId } = req.params;
        
        await cartsCollection.updateOne(
          { userId },
          { 
            $set: { 
              items: [],
              updatedAt: new Date()
            } 
          }
        );

        res.json({ 
          success: true, 
          message: "Cart cleared" 
        });
      } catch (err) {
        res.status(500).json({ 
          success: false,
          message: "Cannot clear cart" 
        });
      }
    });

    // Get cart count
    app.get("/api/cart/:userId/count", verifyFirebaseToken, verifyCartOwner, async (req, res) => {
      try {
        const userId = req.params.userId;
        const cart = await cartsCollection.findOne({ userId });
        
        const count = cart?.items?.reduce((sum, item) => sum + item.qty, 0) || 0;

        res.send({ count });
      } catch (err) {
        res.status(500).send({ error: "Failed to get cart count" });
      }
    });


    // ============================================
    // 🆕 WISHLIST ROUTES
    // ============================================


// GET - Fetch user's wishlist
app.get("/api/wishlist/:userId", verifyFirebaseToken, async (req, res) => {
  try {
    const userId = req.params.userId;

    // Firebase token থেকে email verify করুন
    if(req.tokenEmail !== userId){
      return res.status(403).json({ 
        success: false,
        error: "Forbidden access: User ID does not match token" 
      });
    }

    // Fetch wishlist with product details using aggregation
    const wishlistItems = await wishlistsCollection
      .aggregate([
        { 
          $match: { userId: userId }
        },
        {
          $addFields: {
            productObjectId: { $toObjectId: "$productId" }
          }
        },
        {
          $lookup: {
            from: "products",
            localField: "productObjectId",
            foreignField: "_id",
            as: "productDetails"
          }
        },
        {
          $unwind: {
            path: "$productDetails",
            preserveNullAndEmptyArrays: false
          }
        },
        {
          $sort: { addedAt: -1 }
        },
        {
          $project: {
            _id: 1,
            userId: 1,
            productId: 1,
            addedAt: 1,
            product: "$productDetails"
          }
        }
      ])
      .toArray();

    res.json({
      success: true,
      data: wishlistItems
    });
  } catch (err) {
    console.error('Wishlist fetch error:', err);
    res.status(500).json({ 
      success: false,
      error: "Failed to fetch wishlist",
      message: err.message 
    });
  }
});

// POST - Toggle wishlist (add/remove)
app.post("/api/wishlist/:userId/toggle", verifyFirebaseToken, async (req, res) => {
  try {
    const userId = req.params.userId;
    const { productId } = req.body;

    // Firebase token verify
    if(req.tokenEmail !== userId){
      return res.status(403).json({ 
        success: false,
        message: "Forbidden access" 
      });
    }

    if (!productId) {
      return res.status(400).json({ 
        success: false,
        message: "Product ID is required" 
      });
    }

    // Check if product exists
    const product = await productsCollection.findOne({ 
      _id: new ObjectId(productId) 
    });

    if (!product) {
      return res.status(404).json({ 
        success: false,
        message: "Product not found" 
      });
    }

    // Check if already in wishlist
    const existingItem = await wishlistsCollection.findOne({
      userId: userId,
      productId: productId
    });

    if (existingItem) {
      // Remove from wishlist
      await wishlistsCollection.deleteOne({
        userId: userId,
        productId: productId
      });

      return res.status(200).json({ 
        success: true,
        message: "Product removed from wishlist",
        inWishlist: false 
      });
    } else {
      // Add to wishlist
      const wishlistItem = {
        userId: userId,
        productId: productId,
        addedAt: new Date()
      };

      await wishlistsCollection.insertOne(wishlistItem);

      return res.status(201).json({ 
        success: true,
        message: "Product added to wishlist",
        inWishlist: true 
      });
    }
  } catch (err) {
    console.error('Wishlist toggle error:', err);
    res.status(500).json({ 
      success: false,
      message: "Error toggling wishlist",
      error: err.message 
    });
  }
});

// DELETE - Remove from wishlist
app.delete("/api/wishlist/:userId/remove/:productId", verifyFirebaseToken, async (req, res) => {
  try {
    const { userId, productId } = req.params;

    // Firebase token verify
    if(req.tokenEmail !== userId){
      return res.status(403).json({ 
        success: false,
        message: "Forbidden access" 
      });
    }

    const result = await wishlistsCollection.deleteOne({
      userId: userId,
      productId: productId
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ 
        success: false,
        message: "Item not found in wishlist" 
      });
    }

    res.json({ 
      success: true,
      message: "Product removed from wishlist" 
    });
  } catch (err) {
    console.error('Wishlist remove error:', err);
    res.status(500).json({ 
      success: false,
      message: "Error removing from wishlist",
      error: err.message 
    });
  }
});

// GET - Check if product is in wishlist
app.get("/api/wishlist/:userId/check/:productId", verifyFirebaseToken, async (req, res) => {
  try {
    const { userId, productId } = req.params;

    // Firebase token verify
    if(req.tokenEmail !== userId){
      return res.status(403).json({ 
        success: false,
        message: "Forbidden access" 
      });
    }

    const existingItem = await wishlistsCollection.findOne({
      userId: userId,
      productId: productId
    });

    res.json({ 
      success: true,
      inWishlist: !!existingItem 
    });
  } catch (err) {
    console.error('Wishlist check error:', err);
    res.status(500).json({ 
      success: false,
      error: "Error checking wishlist",
      message: err.message 
    });
  }
});

// GET - Get wishlist count
app.get("/api/wishlist/:userId/count", verifyFirebaseToken, async (req, res) => {
  try {
    const userId = req.params.userId;

    // Firebase token verify
    if(req.tokenEmail !== userId){
      return res.status(403).json({ 
        success: false,
        message: "Forbidden access" 
      });
    }

    const count = await wishlistsCollection.countDocuments({
      userId: userId
    });

    res.json({ 
      success: true,
      count 
    });
  } catch (err) {
    console.error('Wishlist count error:', err);
    res.status(500).json({ 
      success: false,
      error: "Error getting wishlist count",
      message: err.message 
    });
  }
});


// ============================================
// Payment
// CREATE CHECKOUT SESSION
// ============================================

// ============================================
// CREATE CHECKOUT SESSION WITH COUPON SUPPORT
// Replace your existing /api/create-checkout-session route
// ============================================

app.post("/api/create-checkout-session", verifyFirebaseToken, async (req, res) => {
  try {
    const { items, userId, customerEmail, coupon } = req.body;

    console.log('💳 Creating checkout session...');
    console.log('   Customer:', customerEmail);
    console.log('   Items:', items.length);
    console.log('   Coupon:', coupon ? coupon.code : 'None');

    // Validation
    if (!items || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Cart is empty"
      });
    }

    if (!customerEmail) {
      return res.status(400).json({
        success: false,
        message: "Customer email is required"
      });
    }

    // Get user details
    const user = await usersCollection.findOne({ 
      email: customerEmail.toLowerCase() 
    });

    // Calculate totals
    const subtotal = items.reduce((sum, item) => sum + (item.price * item.qty), 0);
    
    // ✅ Apply discount if coupon exists
    let discount = 0;
    if (coupon) {
      if (coupon.type === 'percentage') {
        discount = coupon.discount || 0;
      } else if (coupon.type === 'fixed') {
        discount = coupon.discount || coupon.value || 0;
        if (discount > subtotal) discount = subtotal;
      }
    }

    const tax = (subtotal - discount) * 0.05; // 5% tax on discounted amount
    
    // ✅ Free shipping if coupon type is free_shipping OR order > 1000
    const shipping = coupon?.type === 'free_shipping' || subtotal > 1000 ? 0 : 100;
    
    const total = subtotal - discount + tax + shipping;

    console.log('💰 Pricing breakdown:');
    console.log('   Subtotal:', subtotal);
    console.log('   Discount:', discount);
    console.log('   Tax:', tax);
    console.log('   Shipping:', shipping);
    console.log('   Total:', total);

    // Generate unique order ID
    const orderId = `ORD-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;

    // Convert items to Stripe line items
    const lineItems = items.map(item => {
  // Extract URL from image (handles string or object)
  let imageUrl = '';
  if (typeof item.image === 'string') {
    try {
      const parsed = JSON.parse(item.image);
      imageUrl = parsed.url || '';
    } catch {
      imageUrl = item.image; // already a plain URL
    }
  } else if (typeof item.image === 'object' && item.image?.url) {
    imageUrl = item.image.url;
  }

  return {
    price_data: {
      currency: 'bdt',
      product_data: {
        name: item.name,
        description: `${item.size ? `Size: ${item.size}` : ''} ${item.color ? `Color: ${item.color}` : ''}`.trim() || undefined,
        images: imageUrl ? [imageUrl] : [],
        // ...
      },
      unit_amount: Math.round(item.price * 100),
    },
    quantity: item.qty,
  };
});

    // ✅ Add discount as negative line item if coupon applied
    if (discount > 0) {
      lineItems.push({
        price_data: {
          currency: 'bdt',
          product_data: {
            name: `Discount (${coupon.code})`,
            description: coupon.type === 'percentage' 
              ? `${coupon.value}% OFF` 
              : `$${coupon.value} OFF`
          },
          unit_amount: -Math.round(discount * 100), // Negative amount for discount
        },
        quantity: 1,
      });
    }

    // Add tax as a line item
    if (tax > 0) {
      lineItems.push({
        price_data: {
          currency: 'bdt',
          product_data: {
            name: 'Tax (5%)',
            description: 'Sales tax'
          },
          unit_amount: Math.round(tax * 100),
        },
        quantity: 1,
      });
    }

    // Add shipping as a line item
    if (shipping > 0) {
      lineItems.push({
        price_data: {
          currency: 'bdt',
          product_data: {
            name: 'Shipping Fee',
            description: 'Standard shipping'
          },
          unit_amount: Math.round(shipping * 100),
        },
        quantity: 1,
      });
    }

    // Create Stripe checkout session
    const sessionMetadata = {
      orderId: orderId,
      userId: userId,
      customerEmail: customerEmail,
      itemsCount: items.length.toString(),
      subtotal: subtotal.toString(),
      discount: discount.toString(),
      tax: tax.toString(),
      shipping: shipping.toString(),
      total: total.toString()
    };

    // ✅ Add coupon info to metadata if applied
    if (coupon) {
      sessionMetadata.couponCode = coupon.code;
      sessionMetadata.couponType = coupon.type;
      sessionMetadata.couponDiscount = discount.toString();
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      customer_email: customerEmail,
      client_reference_id: orderId,
      metadata: sessionMetadata,
      success_url: `${process.env.CLIENT_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}&order_id=${orderId}`,
      cancel_url: `${process.env.CLIENT_URL}/checkout/cancel?session_id={CHECKOUT_SESSION_ID}`,
      expires_at: Math.floor(Date.now() / 1000) + (30 * 60), // 30 minutes
    });

    // ✅ Create pending order in database with coupon info
    const orderData = {
      orderId: orderId,
      userId: userId,
      customer: {
        email: customerEmail,
        name: user?.displayName || 'Guest',
        phone: user?.phoneNumber || '',
        address: user?.address || {}
      },
      items: items,
      pricing: {
        subtotal: subtotal,
        discount: discount,
        tax: tax,
        shipping: shipping,
        total: total
      },
      payment: {
        method: 'stripe',
        status: 'pending',
        stripeSessionId: session.id,
        stripePaymentIntentId: null,
        transactionId: null
      },
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    // ✅ Add coupon info to order if applied
    if (coupon) {
      orderData.coupon = {
        code: coupon.code,
        type: coupon.type,
        value: coupon.value || 0,
        discount: discount
      };
    }

    await ordersCollection.insertOne(orderData);

    console.log('✅ Checkout session created:', session.id);
    console.log('✅ Order created:', orderId);

    res.json({
      success: true,
      sessionId: session.id,
      url: session.url,
      orderId: orderId
    });

  } catch (error) {
    console.error('❌ Checkout session error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create checkout session',
      error: error.message
    });
  }
});

// ============================================
// VERIFY PAYMENT STATUS
// ============================================
app.get("/api/checkout/verify/:sessionId", verifyFirebaseToken, async (req, res) => {
  try {
    const { sessionId } = req.params;

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (!session) {
      return res.status(404).json({
        success: false,
        message: 'Session not found'
      });
    }

    const orderId = session.client_reference_id;

    if (!orderId) {
      return res.status(400).json({
        success: false,
        message: 'Order ID not found in session'
      });
    }

    const existingOrder = await ordersCollection.findOne({ orderId: orderId });

    if (!existingOrder) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    if (existingOrder?.payment?.status === 'paid') {
      console.log('⚠️ Order already paid, returning existing data');
      return res.json({
        success: true,
        paymentStatus: 'paid',
        orderStatus: existingOrder.status,
        order: existingOrder
      });
    }

    if (session.payment_status === 'paid') {
      console.log('✅ Payment confirmed, fulfilling order:', orderId);

      // pending → paid atomic; cart clear ও stock কমানো এখানেই (webhook-এর সঙ্গে একই পথ)
      await fulfillPaidOrder(orderId, {
        'payment.stripeSessionId': session.id,
        'payment.stripePaymentIntentId': session.payment_intent,
        'payment.paidAt': new Date()
      });
    }

    const updatedOrder = await ordersCollection.findOne({ orderId: orderId });

    console.log('✅ Verify complete. Payment:', updatedOrder?.payment?.status, '| Order:', updatedOrder?.status);

    return res.json({
      success: true,
      paymentStatus: session.payment_status,
      orderStatus: updatedOrder?.status,
      order: updatedOrder
    });

  } catch (error) {
    console.error('❌ Payment verification error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to verify payment',
      error: error.message
    });
  }
});

// ============================================
// GET ORDER DETAILS
// ============================================

app.get("/api/orders/:orderId", verifyFirebaseToken, async (req, res) => {
  try {
    const { orderId } = req.params;
    const userEmail = req.tokenEmail;

    const order = await ordersCollection.findOne({ orderId: orderId });

    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    // Check if user owns this order
    if (order.customer.email.toLowerCase() !== userEmail.toLowerCase()) {
      // Check if user is admin/staff
      const user = await usersCollection.findOne({ 
        email: userEmail.toLowerCase() 
      });
      
      if (!user || (user.role !== 'admin' && user.role !== 'staff')) {
        return res.status(403).json({
          success: false,
          message: 'Access denied'
        });
      }
    }

    res.json({
      success: true,
      order: order
    });

  } catch (error) {
    console.error('Get order error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch order',
      error: error.message
    });
  }
});

// ============================================
// GET USER ORDERS
// ============================================

app.get("/api/users/:userId/orders", verifyFirebaseToken, async (req, res) => {
  try {
    const { userId } = req.params;
    const { page = 1, limit = 10, status } = req.query;

    // Verify user access
    if (req.tokenEmail !== userId) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    const query = {
      $or: [
        { userId: userId },
        { 'customer.email': userId }
      ]
    };

    if (status) {
      query.status = status;
    }

    const orders = await ordersCollection
      .find(query)
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .toArray();

    const count = await ordersCollection.countDocuments(query);

    res.json({
      success: true,
      orders: orders,
      totalPages: Math.ceil(count / limit),
      currentPage: parseInt(page),
      total: count
    });

  } catch (error) {
    console.error('Get user orders error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch orders',
      error: error.message
    });
  }
});

// ============================================
// REFUND ORDER (Admin only)
// ============================================

app.post("/api/orders/:orderId/refund", verifyFirebaseToken, verifyAdmin, async (req, res) => {
  const { orderId } = req.params;
  let claimed = false;

  try {
    const reason = cleanString(req.body?.reason).slice(0, 500) || 'Customer request';

    // Atomic claim: paid -> refunding (দুবার refund আটকায়)
    const claimResult = await ordersCollection.findOneAndUpdate(
      { orderId, 'payment.status': 'paid' },
      { $set: { 'payment.status': 'refunding', updatedAt: new Date() } },
      { returnDocument: 'before' }
    );

    const order = unwrapFindOneAndUpdate(claimResult);

    if (!order) {
      const exists = await ordersCollection.findOne({ orderId }, { projection: { _id: 1 } });
      return res.status(exists ? 400 : 404).json({
        success: false,
        message: exists
          ? 'Order is not paid, or is already refunded'
          : 'Order not found'
      });
    }

    claimed = true;

    const isStripe = order.payment?.method === 'stripe';
    let refundId = null;

    if (isStripe) {
      if (!order.payment.stripePaymentIntentId) {
        const err = new Error('No payment intent found for this Stripe order');
        err.status = 400;
        throw err;
      }

      const refund = await stripe.refunds.create({
        payment_intent: order.payment.stripePaymentIntentId,
        reason: 'requested_by_customer',
        metadata: { orderId, reason }
      });

      refundId = refund.id;
    }

    // Stripe refund সফল: এখন থেকে আর 'paid'-এ ফেরানো যাবে না
    claimed = false;

    await ordersCollection.updateOne(
      { orderId },
      {
        $set: {
          'payment.status': 'refunded',
          'payment.refundId': refundId,
          'payment.refundMethod': isStripe ? 'stripe' : 'manual',
          'payment.refundedAt': new Date(),
          'payment.refundReason': reason,
          status: 'refunded',
          updatedAt: new Date()
        }
      }
    );

    // Stock: না-পাঠানো অর্ডারে ডিফল্ট ফেরত, shipped/delivered-এ ডিফল্ট ফেরত নয়।
    // body-তে { restock: true/false } দিয়ে বদলানো যায়।
    const restock =
      typeof req.body?.restock === 'boolean'
        ? req.body.restock
        : ['pending', 'processing'].includes(order.status);

    let failedRestore = [];
    if (restock && !order.stockIssue) {
      failedRestore = await restoreStock(order.items);
    }

    res.json({
      success: true,
      message: isStripe
        ? 'Order refunded successfully via Stripe'
        : 'Order marked as refunded. Please return the money to the customer manually.',
      refundMethod: isStripe ? 'stripe' : 'manual',
      stockRestored: restock && !order.stockIssue,
      stockRestoreFailed: failedRestore.length
    });

  } catch (error) {
    if (claimed) {
      // Refund ব্যর্থ হয়েছে: অর্ডার আবার 'paid'-এ
      await ordersCollection
        .updateOne({ orderId }, { $set: { 'payment.status': 'paid', updatedAt: new Date() } })
        .catch((e) => console.error('Refund revert failed:', orderId, e.message));
    }

    console.error('Refund error:', error);
    res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Failed to process refund'
    });
  }
});

// ============================================
// CANCEL ORDER (Customer, শুধু নিজের pending ও অপরিশোধিত অর্ডার)
// ============================================
app.post("/api/orders/:orderId/cancel", verifyFirebaseToken, async (req, res) => {
  try {
    const reason = cleanString(req.body?.reason).slice(0, 500) || 'Cancelled by customer';

    const order = await cancelUnpaidOrder(req.params.orderId, {
      by: 'customer',
      ownerEmail: req.tokenEmail,
      allowedStatuses: ['pending'],
      reason
    });

    res.json({
      success: true,
      message: 'Order cancelled successfully',
      order
    });
  } catch (error) {
    console.error('Customer cancel error:', error);
    res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Failed to cancel order'
    });
  }
});

// ============================================
// MARK AS PAID (Admin: bank deposit / COD, হাতে পেমেন্ট নিশ্চিত)
// ============================================
app.post("/api/orders/:orderId/mark-paid", verifyFirebaseToken, verifyStaff, async (req, res) => {
  try {
    const { orderId } = req.params;
    const reference = cleanString(req.body?.reference).slice(0, 200);
    const note = cleanString(req.body?.note).slice(0, 500);

    let receivedAmount = null;
    const rawAmount = req.body?.receivedAmount;
    if (rawAmount !== undefined && rawAmount !== null && rawAmount !== '') {
      receivedAmount = Number(rawAmount);
      if (!Number.isFinite(receivedAmount) || receivedAmount < 0) {
        return res.status(400).json({ success: false, message: 'Received amount must be a valid number' });
      }
    }

    const existing = await ordersCollection.findOne({ orderId });
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    // Stripe অর্ডার নিজে নিজেই paid হয়। এখানে শুধু হাতে-পরিশোধ পদ্ধতি।
    if (!['bank_deposit', 'cod'].includes(existing.payment?.method)) {
      return res.status(400).json({
        success: false,
        message: 'Only bank deposit or COD orders can be marked as paid manually'
      });
    }

    const amountMismatch =
      receivedAmount !== null && round2(receivedAmount) !== round2(existing.pricing?.total);

    const now = new Date();

    // Atomic: শুধু এখনো অপরিশোধিত থাকলেই (double click / race আটকায়)
    const claim = await ordersCollection.findOneAndUpdate(
      { orderId, 'payment.status': 'pending', status: { $in: ['pending', 'processing', 'shipped', 'delivered'] } },
      {
        $set: {
          'payment.status': 'paid',
          'payment.paidAt': now,
          'payment.paidBy': req.tokenEmail,
          'payment.reference': reference,
          'payment.receivedAmount': receivedAmount,
          'payment.amountMismatch': amountMismatch,
          updatedAt: now
        },
        $push: {
          statusHistory: { status: 'paid', at: now, by: req.tokenEmail, note: note || reference }
        }
      },
      { returnDocument: 'after' }
    );

    let order = unwrapFindOneAndUpdate(claim);

    if (!order) {
      return res.status(409).json({
        success: false,
        message: 'Order is not awaiting payment (already paid, cancelled or refunded)'
      });
    }

    // নতুন (pending) অর্ডার পরিশোধ হলে processing-এ যায়। shipped/delivered অপরিবর্তিত।
    // Stock এখানে কমে না, কারণ offline অর্ডারে তৈরির সময়ই কমেছে।
    if (order.status === 'pending') {
      await ordersCollection.updateOne(
        { orderId, status: 'pending' },
        { $set: { status: 'processing', updatedAt: new Date() } }
      );
      order = await ordersCollection.findOne({ orderId });
    }

    res.json({
      success: true,
      message: amountMismatch
        ? 'Marked as paid, but the received amount differs from the order total'
        : 'Order marked as paid',
      amountMismatch,
      order
    });
  } catch (error) {
    console.error('Mark as paid error:', error);
    res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Failed to mark order as paid'
    });
  }
});

// ============================================
// UPDATE ORDER STATUS (Staff/Admin)
// ============================================

app.patch("/api/orders/:orderId/status", verifyFirebaseToken, verifyStaff, async (req, res) => {
  try {
    const { orderId } = req.params;
    const { status } = req.body;

    const validStatuses = ['pending', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded'];

    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid status'
      });
    }

    if (status === 'refunded') {
      return res.status(400).json({
        success: false,
        message: 'Use the Refund option to refund an order'
      });
    }

    const existing = await ordersCollection.findOne({ orderId });

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    if (['cancelled', 'refunded'].includes(existing.status)) {
      return res.status(400).json({
        success: false,
        message: `A ${existing.status} order cannot be changed`
      });
    }

    // Cancel: stock/coupon ফেরতসহ shared logic দিয়ে
    if (status === 'cancelled') {
      const reason = cleanString(req.body?.reason).slice(0, 500) || 'Cancelled by admin';

      const cancelled = await cancelUnpaidOrder(orderId, {
        by: 'admin',
        allowedStatuses: ['pending', 'processing'],
        reason
      });

      return res.json({
        success: true,
        message: 'Order cancelled',
        order: cancelled
      });
    }

    await ordersCollection.updateOne(
      { orderId },
      { $set: { status, updatedAt: new Date() } }
    );

    const updatedOrder = await ordersCollection.findOne({ orderId });

    res.json({
      success: true,
      message: 'Order status updated',
      order: updatedOrder
    });

  } catch (error) {
    console.error('Update order status error:', error);
    res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Failed to update order status'
    });
  }
});

// GET - Order Statistics (Admin)
app.get("/api/orders/stats/overview", verifyFirebaseToken, verifyAdmin, async (req, res) => {
  try {
    const totalOrders = await ordersCollection.countDocuments();
    const pendingOrders = await ordersCollection.countDocuments({ status: 'pending' });
    const processingOrders = await ordersCollection.countDocuments({ status: 'processing' });
    const shippedOrders = await ordersCollection.countDocuments({ status: 'shipped' });
    const deliveredOrders = await ordersCollection.countDocuments({ status: 'delivered' });
    const cancelledOrders = await ordersCollection.countDocuments({ status: 'cancelled' });
    const refundedOrders = await ordersCollection.countDocuments({ status: 'refunded' });
    const awaitingPayment = await ordersCollection.countDocuments({
      'payment.status': 'pending',
      status: { $nin: ['cancelled', 'refunded'] }
    });
    
    const totalRevenue = await ordersCollection.aggregate([
      { $match: { 'payment.status': 'paid' } },
      { $group: { _id: null, total: { $sum: '$pricing.total' } } }
    ]).toArray();

    res.json({
      success: true,
      stats: {
        totalOrders,
        pendingOrders,
        processingOrders,
        shippedOrders,
        deliveredOrders,
        cancelledOrders,
        refundedOrders,
        awaitingPayment,
        totalRevenue: totalRevenue[0]?.total || 0
      }
    });
  } catch (error) {
    console.error('Get order stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch order statistics',
      error: error.message,
    });
  }
});

// GET - Export Orders CSV (Admin)
app.get("/api/orders/export/csv", verifyFirebaseToken, verifyAdmin, async (req, res) => {
  try {
    const { status, payment, search } = req.query;
    
    const query = {};
    if (status) query.status = status;
    if (payment) query['payment.status'] = payment;
    if (search) {
      query.$or = [
        { orderId: { $regex: search, $options: 'i' } },
        { 'customer.email': { $regex: search, $options: 'i' } }
      ];
    }

    const orders = await ordersCollection.find(query).toArray();

    // CSV generation
    const csvHeader = 'Order ID,Customer Name,Email,Items,Total,Status,Payment,Date\n';
    const csvData = orders.map(order => [
      order.orderId,
      order.customer?.name || '',
      order.customer?.email || '',
      order.items?.length || 0,
      order.pricing?.total?.toFixed(2) || '0.00',
      order.status,
      order.payment?.status || '',
      new Date(order.createdAt).toLocaleDateString()
    ].join(',')).join('\n');

    const csv = csvHeader + csvData;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=orders-${Date.now()}.csv`);
    res.status(200).send(csv);
  } catch (error) {
    console.error('Export orders error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to export orders',
      error: error.message,
    });
  }
});


// ============================================
// COUPON ROUTES
// ============================================

// GET - Get all coupons (Admin/Staff)
app.get("/api/coupons", verifyFirebaseToken, verifyStaff, async (req, res) => {
  try {
    const { status, search } = req.query;
    
    const query = {};
    
    if (status && status !== 'all') {
      query.status = status;
    }
    
    if (search) {
      query.code = { $regex: search, $options: 'i' };
    }

    const coupons = await couponsCollection
      .find(query)
      .sort({ createdAt: -1 })
      .toArray();

    res.json({
      success: true,
      coupons
    });
  } catch (error) {
    console.error('Get coupons error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch coupons',
      error: error.message
    });
  }
});

// GET - Get single coupon by ID (Admin/Staff)
app.get("/api/coupons/:id", verifyFirebaseToken, verifyStaff, async (req, res) => {
  try {
    const { id } = req.params;

    const coupon = await couponsCollection.findOne({
      _id: new ObjectId(id)
    });

    if (!coupon) {
      return res.status(404).json({
        success: false,
        message: 'Coupon not found'
      });
    }

    res.json({
      success: true,
      coupon
    });
  } catch (error) {
    console.error('Get coupon error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch coupon',
      error: error.message
    });
  }
});

// POST - Create new coupon (Admin only)
app.post("/api/coupons", verifyFirebaseToken, verifyAdmin, async (req, res) => {
  try {
    const {
      code,
      type,
      value,
      minOrder,
      maxDiscount,
      limit,
      startDate,
      endDate,
      status
    } = req.body;

    // Validation
    if (!code || !type || !limit || !startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields'
      });
    }

    // Check if code already exists
    const existing = await couponsCollection.findOne({
      code: code.toUpperCase()
    });

    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'Coupon code already exists'
      });
    }

    const newCoupon = {
      code: code.toUpperCase(),
      type, // 'percentage', 'fixed', 'free_shipping'
      value: type === 'free_shipping' ? 0 : parseFloat(value),
      minOrder: parseFloat(minOrder) || 0,
      maxDiscount: maxDiscount ? parseFloat(maxDiscount) : null,
      usage: 0,
      limit: parseInt(limit),
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      status: status || 'active',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const result = await couponsCollection.insertOne(newCoupon);

    res.status(201).json({
      success: true,
      message: 'Coupon created successfully',
      coupon: {
        _id: result.insertedId,
        ...newCoupon
      }
    });
  } catch (error) {
    console.error('Create coupon error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create coupon',
      error: error.message
    });
  }
});

// PUT - Update coupon (Admin only)
app.put("/api/coupons/:id", verifyFirebaseToken, verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = req.body;

    delete updateData._id;
    delete updateData.usage; // Don't allow manual usage update
    
    updateData.updatedAt = new Date();

    // If code is being updated, check uniqueness
    if (updateData.code) {
      const existing = await couponsCollection.findOne({
        code: updateData.code.toUpperCase(),
        _id: { $ne: new ObjectId(id) }
      });

      if (existing) {
        return res.status(400).json({
          success: false,
          message: 'Coupon code already exists'
        });
      }

      updateData.code = updateData.code.toUpperCase();
    }

    const result = await couponsCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: updateData }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'Coupon not found'
      });
    }

    const updatedCoupon = await couponsCollection.findOne({
      _id: new ObjectId(id)
    });

    res.json({
      success: true,
      message: 'Coupon updated successfully',
      coupon: updatedCoupon
    });
  } catch (error) {
    console.error('Update coupon error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update coupon',
      error: error.message
    });
  }
});

// DELETE - Delete coupon (Admin only)
app.delete("/api/coupons/:id", verifyFirebaseToken, verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await couponsCollection.deleteOne({
      _id: new ObjectId(id)
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'Coupon not found'
      });
    }

    res.json({
      success: true,
      message: 'Coupon deleted successfully'
    });
  } catch (error) {
    console.error('Delete coupon error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete coupon',
      error: error.message
    });
  }
});

// ============================================
// PUBLIC COUPON VALIDATION (For users)
// ============================================

// POST - Validate and apply coupon
app.post("/api/coupons/validate", async (req, res) => {
  try {
    const { code, cartTotal } = req.body;

    if (!code) {
      return res.status(400).json({
        success: false,
        message: 'Coupon code is required'
      });
    }

    const coupon = await couponsCollection.findOne({
      code: code.toUpperCase(),
      status: 'active'
    });

    if (!coupon) {
      return res.status(404).json({
        success: false,
        message: 'Invalid coupon code'
      });
    }

    // Check if expired
    const now = new Date();
    if (now < new Date(coupon.startDate) || now > new Date(coupon.endDate)) {
      return res.status(400).json({
        success: false,
        message: 'Coupon has expired'
      });
    }

    // Check usage limit
    if (coupon.usage >= coupon.limit) {
      return res.status(400).json({
        success: false,
        message: 'Coupon usage limit reached'
      });
    }

    // Check minimum order
    if (cartTotal < coupon.minOrder) {
      return res.status(400).json({
        success: false,
        message: `Minimum order amount is $${coupon.minOrder}`
      });
    }

    // Calculate discount
    let discount = 0;
    
    if (coupon.type === 'percentage') {
      discount = (cartTotal * coupon.value) / 100;
      if (coupon.maxDiscount && discount > coupon.maxDiscount) {
        discount = coupon.maxDiscount;
      }
    } else if (coupon.type === 'fixed') {
      discount = coupon.value;
      if (discount > cartTotal) {
        discount = cartTotal;
      }
    }
    // For free_shipping, discount is handled separately in checkout

    res.json({
      success: true,
      message: 'Coupon applied successfully',
      coupon: {
        code: coupon.code,
        type: coupon.type,
        value: coupon.value,
        discount: discount
      }
    });
  } catch (error) {
    console.error('Validate coupon error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to validate coupon',
      error: error.message
    });
  }
});

// POST - Increment coupon usage (called after successful order)
app.post("/api/coupons/use/:code", verifyFirebaseToken, verifyAdmin, async (req, res) => {
  try {
    const { code } = req.params;

    const result = await couponsCollection.updateOne(
      { code: code.toUpperCase() },
      { 
        $inc: { usage: 1 },
        $set: { updatedAt: new Date() }
      }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'Coupon not found'
      });
    }

    res.json({
      success: true,
      message: 'Coupon usage updated'
    });
  } catch (error) {
    console.error('Use coupon error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update coupon usage',
      error: error.message
    });
  }
});

// GET - Coupon statistics (Admin)
app.get("/api/coupons/stats/overview", verifyFirebaseToken, verifyAdmin, async (req, res) => {
  try {
    const totalCoupons = await couponsCollection.countDocuments();
    const activeCoupons = await couponsCollection.countDocuments({ status: 'active' });
    
    const now = new Date();
    const expiredCoupons = await couponsCollection.countDocuments({
      endDate: { $lt: now }
    });

    const totalUsage = await couponsCollection.aggregate([
      {
        $group: {
          _id: null,
          total: { $sum: '$usage' }
        }
      }
    ]).toArray();

    res.json({
      success: true,
      stats: {
        totalCoupons,
        activeCoupons,
        expiredCoupons,
        totalUsage: totalUsage[0]?.total || 0
      }
    });
  } catch (error) {
    console.error('Get coupon stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch coupon statistics',
      error: error.message
    });
  }
});


// ============================================
// 🆕 ADDRESS MANAGEMENT ROUTES
// Paste this block inside run(), after the Coupon routes
// and BEFORE the closing "  } catch (err) {" of run()
// ============================================

// Helper: convert _id -> id and attach for frontend consistency
const formatAddress = (addr) => ({
  ...addr,
  id: addr._id.toString(),
  _id: undefined,
});

// GET - Get all addresses for logged-in user
app.get("/api/addresses", verifyFirebaseToken, async (req, res) => {
  try {
    const addresses = await addressesCollection
      .find({ userId: req.uid })
      .sort({ isDefault: -1, createdAt: -1 })
      .toArray();

    res.status(200).json({
      success: true,
      addresses: addresses.map(formatAddress),
    });
  } catch (error) {
    console.error('Get addresses error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch addresses',
      error: error.message,
    });
  }
});

// POST - Add a new address
app.post("/api/addresses", verifyFirebaseToken, async (req, res) => {
  try {
    const {
      fullName, phone, altPhone, street, aptNumber, city, state,
      zipCode, country, label, isDefault, deliveryNote, landmark, timePreference,
    } = req.body;

    // Basic required field check (mirrors validateAddress on frontend)
      if (!fullName || !phone || !street || !city || !state || !country) {
      return res.status(400).json({
        success: false,
        message: 'Missing required address fields',
      });
    }

    // Check existing addresses count (limit 5, matches frontend hint)
    const existingCount = await addressesCollection.countDocuments({ userId: req.uid });
    if (existingCount >= 5) {
      return res.status(400).json({
        success: false,
        message: 'Maximum 5 addresses allowed. Please delete one to add a new address.',
      });
    }

    // If this is the user's first address, force it to be default
    const shouldBeDefault = existingCount === 0 ? true : !!isDefault;

    // If marking this as default, unset previous defaults
    if (shouldBeDefault) {
      await addressesCollection.updateMany(
        { userId: req.uid },
        { $set: { isDefault: false } }
      );
    }

    const newAddress = {
      userId: req.uid,
      fullName,
      phone,
      altPhone: altPhone || '',
      street,
      aptNumber: aptNumber || '',
      city,
      state,
      zipCode,
      country,
      label: label || 'home',
      isDefault: shouldBeDefault,
      deliveryNote: deliveryNote || '',
      landmark: landmark || '',
      timePreference: timePreference || '',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await addressesCollection.insertOne(newAddress);

    res.status(201).json({
      success: true,
      message: 'Address added successfully',
      address: formatAddress({ ...newAddress, _id: result.insertedId }),
    });
  } catch (error) {
    console.error('Add address error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to add address',
      error: error.message,
    });
  }
});

// PUT - Update an existing address
app.put("/api/addresses/:id", verifyFirebaseToken, async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = req.body;

    delete updateData._id;
    delete updateData.id;
    delete updateData.userId;
    updateData.updatedAt = new Date();

    // Ownership check
    const existing = await addressesCollection.findOne({
      _id: new ObjectId(id),
      userId: req.uid,
    });

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: 'Address not found',
      });
    }

    // If setting this as default, unset others first
    if (updateData.isDefault) {
      await addressesCollection.updateMany(
        { userId: req.uid, _id: { $ne: new ObjectId(id) } },
        { $set: { isDefault: false } }
      );
    }

    await addressesCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: updateData }
    );

    const updated = await addressesCollection.findOne({ _id: new ObjectId(id) });

    res.status(200).json({
      success: true,
      message: 'Address updated successfully',
      address: formatAddress(updated),
    });
  } catch (error) {
    console.error('Update address error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update address',
      error: error.message,
    });
  }
});

// DELETE - Delete an address
app.delete("/api/addresses/:id", verifyFirebaseToken, async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await addressesCollection.findOne({
      _id: new ObjectId(id),
      userId: req.uid,
    });

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: 'Address not found',
      });
    }

    await addressesCollection.deleteOne({ _id: new ObjectId(id) });

    // If the deleted address was default, promote the most recent remaining one
    if (existing.isDefault) {
      const next = await addressesCollection
        .find({ userId: req.uid })
        .sort({ createdAt: -1 })
        .limit(1)
        .toArray();

      if (next.length > 0) {
        await addressesCollection.updateOne(
          { _id: next[0]._id },
          { $set: { isDefault: true } }
        );
      }
    }

    res.status(200).json({
      success: true,
      message: 'Address deleted successfully',
    });
  } catch (error) {
    console.error('Delete address error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete address',
      error: error.message,
    });
  }
});

// PATCH - Set an address as default
app.patch("/api/addresses/:id/default", verifyFirebaseToken, async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await addressesCollection.findOne({
      _id: new ObjectId(id),
      userId: req.uid,
    });

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: 'Address not found',
      });
    }

    // Unset all, then set this one
    await addressesCollection.updateMany(
      { userId: req.uid },
      { $set: { isDefault: false } }
    );

    await addressesCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { isDefault: true, updatedAt: new Date() } }
    );

    res.status(200).json({
      success: true,
      message: 'Default address updated successfully',
    });
  } catch (error) {
    console.error('Set default address error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to set default address',
      error: error.message,
    });
  }
});

    
  } catch (err) {
    console.error("MongoDB connection error:", err);
  }
}

run().catch(console.dir);

app.get("/", async (req, res) => {
  res.send("E-Commerce Server Site is running");
});

app.listen(port, () =>
  console.log(`E-Commerce Server Site Is Running on http://localhost:${port}`)
);
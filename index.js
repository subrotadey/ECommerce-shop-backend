// E-commerce Server site
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
require("dotenv").config();
const cloudinary = require("cloudinary").v2;
const port = process.env.PORT || 5000;

const app = express();

//middleware
const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:3000",
  "https://anis-abaiya.web.app",
  "https://anis-abaiya.firebaseapp.com"
];

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, Postman, etc.)
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


app.use(express.json());
app.use(cookieParser());


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

// Firebase Token verification (for Authorization header)
const verifyFirebaseToken = async (req, res, next) => {
  try {
    const authHeader = req?.headers?.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        success: false,
        message: "No token provided. Authorization header must be in format: Bearer <token>" 
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
    console.error('Token verification error:', error);
    
    if (error.code === 'auth/id-token-expired') {
      return res.status(401).json({
        success: false,
        message: 'Token expired. Please login again.'
      });
    }
    
    return res.status(401).json({
      success: false,
      message: 'Invalid or expired token',
      error: error.message
    });
  }
};



// Admin role verification
const verifyAdmin = async (req, res, next) => {
  try {
    const email = req.tokenEmail;
    
    if (!email) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
    }

    const user = await usersCollection.findOne({ email: email.toLowerCase() });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    if (user.role !== 'admin') {
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

// Staff role verification middleware
const verifyStaff = async (req, res, next) => {
  try {
    const email = req.tokenEmail;
    
    if (!email) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
    }

    const user = await usersCollection.findOne({ email: email.toLowerCase() });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Admin অথবা Staff - দুজনেই access পাবে
    if (user.role !== 'admin' && user.role !== 'staff') {
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

// Configure Cloudinary (add after MongoDB setup)
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

async function run() {
  try {
    await client.connect();

    const database = client.db("eCommerceDB");

    // Collections
    const productsCollection = database.collection("products");
    const cartsCollection = database.collection("carts");
    const wishlistsCollection = database.collection("wishlists")
    const usersCollection = database.collection("users")
    const ordersCollection = database.collection("orders");

    console.log("All collections initialized");

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

app.post("/jwt", (req, res) => {
  const userData = req.body;

  const token = jwt.sign(
    {
      email: userData.email,
    }, 
    process.env.JWT_ACCESS_SECRET, 
    {
      expiresIn: "7d",
    }
  );

  // ✅ Cookie settings
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
        const { uid, email, displayName, photoURL, emailVerified, provider } = req.body;

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
    app.get("/api/users/role/:email", async (req, res) => {
      try {
        const { email } = req.params;

        if (!email) {
          return res.status(400).json({
            success: false,
            message: 'Email is required',
          });
        }

        const user = await usersCollection.findOne({ 
          email: email.toLowerCase() 
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
    const { page = 1, limit = 10, status, search } = req.query;

    const query = {};
    
    if (status) query.status = status;
    if (search) {
      query.$or = [
        { orderId: { $regex: search, $options: 'i' } },
        { 'customer.email': { $regex: search, $options: 'i' } },
      ];
    }

    const orders = await ordersCollection.find(query)
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .sort({ createdAt: -1 })
      .toArray();

    const count = await ordersCollection.countDocuments(query);

    res.status(200).json({
      success: true,
      orders,
      totalPages: Math.ceil(count / limit),
      currentPage: parseInt(page),
      total: count,
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
    // PRODUCTS ROUTES
    // ============================================
    app.get("/products", async (req, res) => {
      try {
        const { category, minPrice, maxPrice, size, color, tag } = req.query;

        let query = {};

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

    app.get("/products/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const product = await productsCollection.findOne(query);
        
        if (!product) {
          return res.status(404).send({ error: "Product not found" });
        }
        
        res.send(product);
      } catch (err) {
        res.status(500).send({ error: "Failed to fetch product" });
      }
    });


    // POST - Create new product
app.post("/api/products", async (req, res) => {
  try {
    const productData = req.body;

    // Validate required fields
    const requiredFields = ['sku', 'productName', 'newPrice', 'stock'];
    for (const field of requiredFields) {
      if (!productData[field]) {
        return res.status(400).json({ 
          success: false,
          message: `Missing required field: ${field}` 
        });
      }
    }

    // Validate images array
    if (!productData.images || !Array.isArray(productData.images) || productData.images.length === 0) {
      return res.status(400).json({ 
        success: false,
        message: "At least one product image is required" 
      });
    }

    // Validate price values
    if (productData.newPrice <= 0) {
      return res.status(400).json({ 
        success: false,
        message: "Price must be greater than 0" 
      });
    }

    if (productData.oldPrice && productData.oldPrice < productData.newPrice) {
      return res.status(400).json({ 
        success: false,
        message: "Old price must be greater than new price" 
      });
    }

    // Validate stock
    if (productData.stock < 0) {
      return res.status(400).json({ 
        success: false,
        message: "Stock cannot be negative" 
      });
    }

    // Check if SKU already exists
    const existingProduct = await productsCollection.findOne({ 
      sku: productData.sku 
    });
    
    if (existingProduct) {
      return res.status(400).json({ 
        success: false,
        message: "Product with this SKU already exists" 
      });
    }

    // Add timestamps
    productData.createdAt = new Date();
    productData.updatedAt = new Date();
    
    if (!productData.status) {
      productData.status = 'active';
    }

    // Insert product
    const result = await productsCollection.insertOne(productData);

    res.status(201).json({
      success: true,
      message: "Product created successfully",
      product: {
        _id: result.insertedId,
        ...productData
      }
    });

  } catch (err) {
    res.status(500).json({ 
      success: false,
      message: "Error creating product", 
      error: err.message 
    });
  }
});


    // PUT - Update product
    app.put("/api/products/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const updateData = req.body;

        delete updateData._id;
        updateData.updatedAt = new Date();

        const result = await productsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: updateData }
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
          message: "Product updated successfully",
          product: updatedProduct
        });

      } catch (err) {
        res.status(500).json({ 
          success: false,
          message: "Error updating product", 
          error: err.message 
        });
      }
    });


    // DELETE - Delete product
    app.delete("/api/products/:id", async (req, res) => {
      try {
        const id = req.params.id;

        const result = await productsCollection.deleteOne({ 
          _id: new ObjectId(id) 
        });

        if (result.deletedCount === 0) {
          return res.status(404).json({ 
            success: false,
            message: "Product not found" 
          });
        }

        res.json({
          success: true,
          message: "Product deleted successfully"
        });

      } catch (err) {
        res.status(500).json({ 
          success: false,
          message: "Error deleting product", 
          error: err.message 
        });
      }
    });


    // PATCH - Update product status
    app.patch("/api/products/:id/status", async (req, res) => {
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
app.delete("/api/cloudinary/delete/image", async (req, res) => {
  try {
    const { publicId } = req.body;

    if (!publicId) {
      return res.status(400).json({ 
        success: false,
        message: "Public ID is required" 
      });
    }

    // Verify Cloudinary config
    const config = cloudinary.config();
    console.log("Cloudinary Config Check:", {
      cloudName: config.cloud_name,
      apiKey: config.api_key,
      hasApiSecret: !!config.api_secret,
      secretLength: config.api_secret?.length
    });

    if (!config.cloud_name || !config.api_key || !config.api_secret) {
      return res.status(500).json({
        success: false,
        message: "Cloudinary configuration error"
      });
    }
    
    // Delete from Cloudinary
    const result = await cloudinary.uploader.destroy(publicId, {
      invalidate: true,
      resource_type: 'image'
    });


    // Handle different result statuses
    if (result.result === 'ok') {
      return res.json({ 
        success: true,
        message: "Image deleted successfully from Cloudinary",
        result: result
      });
    } else if (result.result === 'not found') {
      return res.json({ 
        success: true,
        message: "Image not found (may already be deleted)",
        result: result
      });
    } else {
      return res.status(500).json({ 
        success: false,
        message: "Failed to delete image",
        result: result
      });
    }

  } catch (err) {
    console.error("Error details:", {
      message: err.message,
      name: err.name,
      code: err.code,
      http_code: err.http_code
    });
    
    res.status(500).json({ 
      success: false,
      message: err.message || "Error deleting image from Cloudinary",
      error: {
        message: err.message,
        name: err.name,
        http_code: err.http_code
      }
    });
  }
});

// DELETE single video from Cloudinary
app.delete("/api/cloudinary/delete/video", async (req, res) => {
  try {
    const { publicId } = req.body;


    if (!publicId) {
      return res.status(400).json({ 
        success: false,
        message: "Public ID is required" 
      });
    }

    const result = await cloudinary.uploader.destroy(publicId, {
      invalidate: true,
      resource_type: 'video'
    });

    if (result.result === 'ok' || result.result === 'not found') {
      return res.json({ 
        success: true,
        message: "Video deleted successfully",
        result: result
      });
    } else {
      return res.status(500).json({ 
        success: false,
        message: "Failed to delete video",
        result: result
      });
    }

  } catch (err) {
    res.status(500).json({ 
      success: false,
      message: "Error deleting video from Cloudinary",
      error: err.message 
    });
  }
});

// DELETE batch images
app.post("/api/cloudinary/delete/batch", async (req, res) => {
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

app.get("/api/cart/:userId", async (req, res) => {
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
app.post("/api/cart/:userId", async (req, res) => {
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
    app.post("/api/cart/:userId/add", async (req, res) => {
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
    app.patch("/api/cart/:userId/update/:itemKey", async (req, res) => {
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
    app.delete("/api/cart/:userId/remove/:itemKey", async (req, res) => {
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
    app.delete("/api/cart/:userId/clear", async (req, res) => {
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
    app.get("/api/cart/:userId/count", async (req, res) => {
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
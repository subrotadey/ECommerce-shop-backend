// E-commerce Server site
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
require("dotenv").config();
const cloudinary = require("cloudinary").v2;
const port = process.env.PORT || 5000;

const app = express();

//middleware
app.use(cors({
  origin: ['http://localhost:5173'],
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());



var admin = require("firebase-admin");

var serviceAccount = require("./anis-abaiya-firebase-admin-key.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

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
    // console.log('Decoded JWT:', decoded);
    next();
  });
}

const verifyFirebaseToken = async(req, res, next) => {
  const authHeader = req?.headers?.authorization;
  const token = authHeader.split(' ')[1]
  if(!token){
    return res.status(401).json({ 
      success: false,
      message: "Unauthorized access, token missing" 
    });
  }
  const userInfo = await admin.auth().verifyIdToken(token);
  req.tokenEmail = userInfo?.email
  next()
}

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
    console.log("✅ Database connected");

    const database = client.db("eCommerceDB");

    // Collections
    const productsCollection = database.collection("products");
    const cartsCollection = database.collection("carts");
    const wishlistsCollection = database.collection("wishlists")

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
      });

      // set the token in an HTTP-only cookie
      res.cookie('access_token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production', // use secure cookies in production
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
        sameSite: 'Lax',
      });

      res.send({success: true});
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




    // ============================================
// 🆕 NEW ROUTES - ADD THESE BELOW
// ============================================

    // POST - Create new product (IMPROVED VALIDATION)
app.post("/api/products", async (req, res) => {
  try {
    const productData = req.body;

    // ✅ Validate required fields
    const requiredFields = ['sku', 'productName', 'newPrice', 'stock'];
    for (const field of requiredFields) {
      if (!productData[field]) {
        return res.status(400).json({ 
          success: false,
          message: `Missing required field: ${field}` 
        });
      }
    }

    // ✅ NEW: Validate images array
    if (!productData.images || !Array.isArray(productData.images) || productData.images.length === 0) {
      return res.status(400).json({ 
        success: false,
        message: "At least one product image is required" 
      });
    }

    // ✅ NEW: Validate price values
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

    // ✅ NEW: Validate stock
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

    // ============================================
// CLOUDINARY DELETE ROUTES (FIXED VERSION)
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
    console.log('🔍 GET /api/cart/:userId - Fetching cart for:', userId);

    const cart = await cartsCollection.findOne({ userId });
    console.log('📦 Cart found in DB:', cart ? `${cart.items?.length} items` : 'No cart');

    res.json({ 
      success: true,
      items: cart?.items || [] 
    });
  } catch (err) {
    console.error("❌ GET cart error:", err);
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
    app.get("/api/wishlist/:userId", verifyToken, verifyFirebaseToken, verifyEmailToken, async (req, res) => {
      try {
        const userId = req.params.userId;

        if(req.tokenEmail != userId){
          return res.status(403).json({ 
            error: "Forbidden access: User ID does not match token" 
          });
        }

        if (!userId) {
          return res.status(400).json({ 
            error: "User ID is required" 
          });
        }

        // Fetch wishlist with product details using aggregation
        const wishlistItems = await wishlistsCollection
          .aggregate([
            { 
              $match: { userId: userId } // Using string userId
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

        res.send(wishlistItems);
      } catch (err) {
        res.status(500).send({ 
          error: "Failed to fetch wishlist",
          message: err.message 
        });
      }
    });

    // POST - Toggle wishlist (add/remove)
    app.post("/api/wishlist/:userId/toggle", async (req, res) => {
      try {
        const userId = req.params.userId;
        const { productId } = req.body;

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
        res.status(500).json({ 
          success: false,
          message: "Error toggling wishlist",
          error: err.message 
        });
      }
    });

    // DELETE - Remove from wishlist
    app.delete("/api/wishlist/:userId/remove/:productId", async (req, res) => {
      try {
        const { userId, productId } = req.params;

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
        res.status(500).json({ 
          success: false,
          message: "Error removing from wishlist",
          error: err.message 
        });
      }
    });

    // GET - Check if product is in wishlist
    app.get("/api/wishlist/:userId/check/:productId", async (req, res) => {
      try {
        const { userId, productId } = req.params;

        const existingItem = await wishlistsCollection.findOne({
          userId: userId,
          productId: productId
        });

        res.json({ inWishlist: !!existingItem });
      } catch (err) {
        res.status(500).json({ 
          error: "Error checking wishlist",
          message: err.message 
        });
      }
    });

    // GET - Get wishlist count
    app.get("/api/wishlist/:userId/count", async (req, res) => {
      try {
        const userId = req.params.userId;

        const count = await wishlistsCollection.countDocuments({
          userId: userId
        });

        res.json({ count });
      } catch (err) {
        res.status(500).json({ 
          error: "Error getting wishlist count",
          message: err.message 
        });
      }
    });
  } catch (err) {
    console.error("❌ MongoDB connection error:", err);
  }
}

run().catch(console.dir);

app.get("/", async (req, res) => {
  res.send("E-Commerce Server Site is running");
});

app.listen(port, () =>
  console.log(`E-Commerce Server Site Is Running on http://localhost:${port}`)
);
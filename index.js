// E-commerce Server site - FIXED

const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
require("dotenv").config();
const port = process.env.PORT || 5000;

const app = express();

//middleware
app.use(cors());
app.use(express.json());

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.hs9qs.mongodb.net/?retryWrites=true&w=majority`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

async function run() {
  try {
    await client.connect();
    console.log("✅ Database connected");

    const database = client.db("eCommerceDB");

    // Collections
    const productsCollection = database.collection("products");
    const cartsCollection = database.collection("carts");

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
        console.error("❌ Products fetch error:", err);
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
        console.error("❌ Product fetch error:", err);
        res.status(500).send({ error: "Failed to fetch product" });
      }
    });

    // ============================================
    // CART ROUTES - FIXED (using cartsCollection directly)
    // ============================================

    // GET user cart
    app.get("/api/cart/:userId", async (req, res) => {
      try {
        const userId = req.params.userId;
        console.log("📥 GET cart for user:", userId);

        const cart = await cartsCollection.findOne({ userId });
        console.log("Cart found:", cart ? "Yes" : "No");

        res.send({ items: cart?.items || [] });
      } catch (err) {
        console.error("❌ Cart fetch error:", err);
        res.status(500).send({ error: "Failed to fetch cart" });
      }
    });

    // POST/UPDATE full cart
    app.post("/api/cart/:userId", async (req, res) => {
      try {
        const userId = req.params.userId;
        const items = req.body.items || [];

        console.log("💾 Saving cart for user:", userId);
        console.log("Items count:", items.length);

        // Validate items
        const validItems = items.filter(item => 
          item.key && item.productId && item.qty > 0
        );

        console.log("Valid items count:", validItems.length);

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

        console.log("✅ Cart saved. Modified:", result.modifiedCount, "Upserted:", result.upsertedCount);

        res.send({ success: true, items: validItems });
      } catch (err) {
        console.error("❌ Cart save error:", err);
        res.status(500).send({ error: "Failed to save cart" });
      }
    });

    // ADD single item
    app.post("/api/cart/:userId/add", async (req, res) => {
      try {
        const { userId } = req.params;
        const item = req.body;

        console.log("➕ Adding item for user:", userId);

        if (!item || !item.key || !item.productId || !item.qty) {
          return res.status(400).json({ 
            success: false,
            message: "Invalid cart item. Must have key, productId, and qty" 
          });
        }

        const cart = await cartsCollection.findOne({ userId });

        if (!cart) {
          console.log("Creating new cart...");
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

        console.log("✅ Item added");
        res.json({ 
          success: true, 
          message: "Item added to cart",
          items: cart.items
        });
      } catch (err) {
        console.error("❌ Add to cart error:", err);
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

        console.log("🔄 Updating item:", itemKey, "qty:", qty);

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

        console.log("✅ Cart updated");
        res.json({ 
          success: true, 
          message: "Cart updated",
          items: cart.items
        });
      } catch (err) {
        console.error("❌ Update cart error:", err);
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

        console.log("🗑️ Removing item:", itemKey);
        
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

        console.log("✅ Item removed");
        res.json({ 
          success: true, 
          message: "Item removed from cart" 
        });
      } catch (err) {
        console.error("❌ Remove error:", err);
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

        console.log("🧹 Clearing cart for:", userId);
        
        await cartsCollection.updateOne(
          { userId },
          { 
            $set: { 
              items: [],
              updatedAt: new Date()
            } 
          }
        );

        console.log("✅ Cart cleared");
        res.json({ 
          success: true, 
          message: "Cart cleared" 
        });
      } catch (err) {
        console.error("❌ Clear cart error:", err);
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
        console.error("❌ Cart count error:", err);
        res.status(500).send({ error: "Failed to get cart count" });
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
  console.log(`🚀 E-Commerce Server Site Is Running on http://localhost:${port}`)
);
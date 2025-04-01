const express = require("express")
const mongoose = require("mongoose")
const cors = require("cors")
const bcrypt = require("bcryptjs")
const jwt = require("jsonwebtoken")
const multer = require("multer")
const path = require("path")
const { v2: cloudinary } = require("cloudinary")
const { CloudinaryStorage } = require("multer-storage-cloudinary")
require("dotenv").config()

const app = express()
app.use(express.json())
app.use(cors())

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
})

// Configure Cloudinary storage
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: "dream-house-products",
    allowed_formats: ["jpg", "jpeg", "png", "gif"],
    transformation: [{ width: 1000, height: 1000, crop: "limit" }],
  },
})

// Configure multer with Cloudinary storage
const upload = multer({ storage })

// Fallback local storage for development or if Cloudinary isn't configured
const localUploadDir = path.join(__dirname, "uploads")
const localStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, localUploadDir)
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9)
    const ext = path.extname(file.originalname)
    cb(null, uniqueSuffix + ext)
  },
})

// Determine which storage to use
const isCloudinaryConfigured =
  process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET

const uploadMiddleware = isCloudinaryConfigured
  ? upload.single("image")
  : multer({ storage: localStorage }).single("image")

// Serve local uploads if needed
app.use("/uploads", express.static(localUploadDir))

// **Connect to MongoDB**
mongoose
  .connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log("✅ MongoDB Connected"))
  .catch((err) => console.error("❌ MongoDB Connection Error:", err))

// **User Schema**
const UserSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  isAdmin: { type: Boolean, default: true },
})
const User = mongoose.model("User", UserSchema)

// **Product Schema**
const ProductSchema = new mongoose.Schema({
  name: { type: String, required: true },
  price: { type: Number, required: true },
  category: { type: String, required: true },
  subCategory: { type: String },
  description: { type: String },
  imageUrl: { type: String }, // Store Image URL
  cloudinaryId: { type: String }, // Store Cloudinary ID for image management
  featured: { type: Boolean, default: false },
})

const Product = mongoose.model("Product", ProductSchema)

// **Middleware to verify admin**
const verifyToken = (req, res, next) => {
  const token = req.headers["authorization"]
  if (!token) return res.status(403).json({ message: "❌ Access Denied. No token provided." })

  try {
    const decoded = jwt.verify(token.split(" ")[1], process.env.SECRET_KEY)
    req.user = decoded
    next()
  } catch (error) {
    res.status(401).json({ message: "❌ Invalid or Expired Token" })
  }
}

// **Admin Login**
app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body
    const admin = await User.findOne({ email })

    if (!admin) return res.status(400).json({ message: "❌ Admin not found." })

    const isMatch = await bcrypt.compare(password, admin.password)
    if (!isMatch) return res.status(400).json({ message: "❌ Incorrect password." })

    // Generate JWT token
    const token = jwt.sign({ id: admin._id, isAdmin: true }, process.env.SECRET_KEY, { expiresIn: "1d" })

    res.json({ token, user: admin })
  } catch (error) {
    console.error("❌ Login Error:", error)
    res.status(500).json({ message: "❌ Internal Server Error" })
  }
})

// **Add Product (Admin Only, Supports Image Upload)**
app.post("/api/products", verifyToken, uploadMiddleware, async (req, res) => {
  try {
    if (!req.user.isAdmin) return res.status(403).json({ message: "❌ Unauthorized. Admin access required." })

    const { name, price, category, subCategory, description } = req.body

    let imageUrl = null
    let cloudinaryId = null

    if (req.file) {
      if (isCloudinaryConfigured) {
        // If using Cloudinary, the URL is already in req.file.path
        imageUrl = req.file.path
        cloudinaryId = req.file.filename
      } else {
        // If using local storage
        imageUrl = `/uploads/${req.file.filename}`
      }
    }

    if (!name || !price || !category) {
      return res.status(400).json({ message: "⚠️ All required fields must be filled" })
    }

    const newProduct = new Product({
      name,
      price,
      category,
      subCategory,
      description,
      imageUrl,
      cloudinaryId,
    })

    await newProduct.save()

    res.status(201).json({ message: "✅ Product added successfully", product: newProduct })
  } catch (error) {
    console.error("❌ Error Adding Product:", error)
    res.status(500).json({ message: "❌ Error adding product" })
  }
})

// **Update Product (Admin Only)**
app.put("/api/products/:id", verifyToken, uploadMiddleware, async (req, res) => {
  try {
    if (!req.user.isAdmin) return res.status(403).json({ message: "❌ Unauthorized. Admin access required." })

    const productId = req.params.id
    const { name, price, category, subCategory, description } = req.body

    // Get the existing product
    const product = await Product.findById(productId)
    if (!product) {
      return res.status(404).json({ message: "❌ Product not found" })
    }

    // Handle image update
    let imageUrl = product.imageUrl
    let cloudinaryId = product.cloudinaryId

    if (req.file) {
      // If there's a new image, delete the old one from Cloudinary if it exists
      if (isCloudinaryConfigured && product.cloudinaryId) {
        try {
          await cloudinary.uploader.destroy(product.cloudinaryId)
        } catch (err) {
          console.error("Error deleting old image from Cloudinary:", err)
        }
      }

      if (isCloudinaryConfigured) {
        imageUrl = req.file.path
        cloudinaryId = req.file.filename
      } else {
        imageUrl = `/uploads/${req.file.filename}`
      }
    }

    // Update the product
    const updatedProduct = await Product.findByIdAndUpdate(
      productId,
      {
        name,
        price,
        category,
        subCategory,
        description,
        imageUrl,
        cloudinaryId,
      },
      { new: true },
    )

    res.json(updatedProduct)
  } catch (error) {
    console.error("❌ Error Updating Product:", error)
    res.status(500).json({ message: "❌ Error updating product" })
  }
})

// **Delete Product (Admin Only)**
app.delete("/api/products/:id", verifyToken, async (req, res) => {
  try {
    if (!req.user.isAdmin) return res.status(403).json({ message: "❌ Unauthorized. Admin access required." })

    const product = await Product.findById(req.params.id)
    if (!product) {
      return res.status(404).json({ message: "❌ Product not found" })
    }

    // Delete image from Cloudinary if it exists
    if (isCloudinaryConfigured && product.cloudinaryId) {
      try {
        await cloudinary.uploader.destroy(product.cloudinaryId)
      } catch (err) {
        console.error("Error deleting image from Cloudinary:", err)
      }
    }

    await Product.findByIdAndDelete(req.params.id)
    res.json({ message: "✅ Product deleted successfully." })
  } catch (error) {
    console.error("❌ Error Deleting Product:", error)
    res.status(500).json({ message: "❌ Error deleting product" })
  }
})

// **Fetch All Products (For Website)**
app.get("/api/products", async (req, res) => {
  try {
    const limit = req.query.limit ? Number.parseInt(req.query.limit) : 0
    const query = Product.find()

    if (limit > 0) {
      query.limit(limit)
    }

    const products = await query.exec()
    res.json(products)
  } catch (error) {
    console.error("❌ Error Fetching Products:", error)
    res.status(500).json({ message: "❌ Error fetching products" })
  }
})

// **Toggle Featured Status**
app.patch("/api/products/:id", verifyToken, async (req, res) => {
  try {
    if (!req.user.isAdmin) return res.status(403).json({ message: "❌ Unauthorized. Admin access required." })

    const { featured } = req.body
    const updatedProduct = await Product.findByIdAndUpdate(req.params.id, { featured }, { new: true })

    res.json(updatedProduct)
  } catch (error) {
    console.error("❌ Error Updating Product:", error)
    res.status(500).json({ message: "❌ Error updating product" })
  }
})

// Start the server
const PORT = process.env.PORT || 5000
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`))


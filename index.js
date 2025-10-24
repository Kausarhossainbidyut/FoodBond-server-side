const express = require("express");
const cors = require("cors");

const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const dotenv = require("dotenv");
dotenv.config();

const admin = require("firebase-admin");

// Initialize Firebase Admin only if service account exists
let serviceAccount;
try {
  serviceAccount = require("./admin-key.json");
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
} catch (error) {
  console.log("Firebase service account not found, running in limited mode");
}

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB Connection
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.fk8frlr.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

let db;
let foodsCollection;
let notificationsCollection;
let requestsCollection;

// Function to connect to database
async function connectToDatabase() {
  try {
    // Connect the client to the server (optional starting in v4.7)
    await client.connect();
    // Establish and verify connection
    await client.db("admin").command({ ping: 1 });
    console.log("✅ Pinged your deployment. You successfully connected to MongoDB!");
    
    db = client.db("assignment11");
    foodsCollection = db.collection("foods");
    notificationsCollection = db.collection("notifications");
    requestsCollection = db.collection("requests");
    
    return true;
  } catch (error) {
    console.error("❌ MongoDB connection error:", error);
    return false;
  }
}

// Middleware to ensure database connection
const ensureDatabaseConnection = async (req, res, next) => {
  if (!db) {
    const isConnected = await connectToDatabase();
    if (!isConnected) {
      return res.status(500).json({ message: 'Database connection failed' });
    }
  }
  next();
};

// middleware/auth.js
const verifyFirebaseToken = async (req, res, next) => {
  // Ensure database is connected
  if (!db) {
    const isConnected = await connectToDatabase();
    if (!isConnected) {
      return res.status(500).json({ message: 'Database connection failed' });
    }
  }
  
  const authHeader = req.headers.authorization;
  // console.log('auth:',authHeader);

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Unauthorized: No token provided' });
  }

  const idToken = authHeader.split(' ')[1];

  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.firebaseUser = decodedToken; // You can access user info like uid, email, etc.
    next();
    console.log('decoderToken:', decodedToken);

  } catch (error) {
    return res.status(401).json({ message: 'Unauthorized: Invalid token from catch' });
  }
};

// Root route
app.get("/", (req, res) => {
  res.send("Server is running!");
});

// Apply database connection middleware to all routes
app.use(ensureDatabaseConnection);

//This is for /add-food page
app.post('/add-food', async (req, res) => {
  try {
    const data = req.body;
    const result = await foodsCollection.insertOne(data);
    res.send(result);
  } catch (error) {
    console.error("Error in /add-food:", error);
    res.status(500).send({ error: "Failed to add food" });
  }
})

//This is for /home/featured-foods page
app.get("/featured-foods", async (req, res) => {
  try {
    const data = await foodsCollection.aggregate([
      {
        $match: { status: "available" }
      },
      {
        $addFields: {
          quantityNum: { $toInt: "$quantity" }
        }
      },
      {
        $sort: { quantityNum: -1 }
      },
      {
        $limit: 6
      }
    ]).toArray();

    res.send(data);
  } catch (err) {
    console.error("Error in /featured-foods:", err);
    res.status(500).send({ error: "Internal Server Error" });
  }
});

//This is for /available-food page
app.get("/available-food", async (req, res) => {
  const { foodName, location, sortBy, minQuantity, maxQuantity, startDate, endDate } = req.query;

  let query = { status: "available" };

  // Search by food name
  if (foodName) {
    query.foodName = { $regex: foodName, $options: "i" };  // case-insensitive search
  }

  // Filter by location
  if (location) {
    query.location = { $regex: location, $options: "i" };
  }

  // Filter by quantity range
  if (minQuantity || maxQuantity) {
    query.quantity = {};
    if (minQuantity) {
      query.$expr = { ...query.$expr, $gte: [{ $toInt: "$quantity" }, parseInt(minQuantity)] };
    }
    if (maxQuantity) {
      query.$expr = { ...query.$expr, $lte: [{ $toInt: "$quantity" }, parseInt(maxQuantity)] };
    }
  }

  // Filter by expiration date range
  if (startDate || endDate) {
    query.expirationDate = {};
    if (startDate) {
      query.expirationDate.$gte = startDate;
    }
    if (endDate) {
      query.expirationDate.$lte = endDate;
    }
  }

  // Determine sort order
  let sortOptions = { expirationDate: 1 }; // default: nearest expiry first
  
  if (sortBy === 'quantity-high') {
    sortOptions = { quantity: -1 };
  } else if (sortBy === 'quantity-low') {
    sortOptions = { quantity: 1 };
  } else if (sortBy === 'expiry-nearest') {
    sortOptions = { expirationDate: 1 };
  } else if (sortBy === 'expiry-farthest') {
    sortOptions = { expirationDate: -1 };
  } else if (sortBy === 'name-asc') {
    sortOptions = { foodName: 1 };
  } else if (sortBy === 'name-desc') {
    sortOptions = { foodName: -1 };
  }

  try {
    const data = await foodsCollection
      .find(query)
      .sort(sortOptions)
      .toArray();
    res.send(data);
  } catch (error) {
    console.error("Error fetching available foods:", error);
    res.status(500).send({ message: "Server error" });
  }
});

//This for /food-details/:foodId
app.get("/food-details/:id", async (req, res) => {
  const query = { _id: new ObjectId(req.params.id) }
  const data = await foodsCollection.findOne(query)
  res.send(data)
})

//this is for register/:id - UPDATED FOR QUANTITY-BASED REQUESTS
app.patch("/request/:id", verifyFirebaseToken, async (req, res) => {
  const { userNotes, requestedQuantity } = req.body;
  const query = { _id: new ObjectId(req.params.id) };

  try {
    // Get the food item
    const food = await foodsCollection.findOne(query);
    
    if (!food) {
      return res.status(404).send({ error: "Food not found" });
    }

    // Parse quantities
    const availableQty = parseInt(food.quantity);
    const requestedQty = parseInt(requestedQuantity) || 1;

    // Validate requested quantity
    if (requestedQty <= 0) {
      return res.status(400).send({ error: "Requested quantity must be greater than 0" });
    }

    if (requestedQty > availableQty) {
      return res.status(400).send({ error: `Only ${availableQty} portions available` });
    }

    // Calculate new quantity
    const newQuantity = availableQty - requestedQty;

    // Update food quantity and status
    const updateDoc = {
      $set: {
        quantity: newQuantity.toString(),
        status: newQuantity === 0 ? "unavailable" : "available"
      },
    };

    const result = await foodsCollection.updateOne(query, updateDoc);

    // Create a request record
    const requestRecord = {
      foodId: food._id,
      foodName: food.foodName,
      foodImage: food.foodImage,
      donorEmail: food.donorEmail,
      donorName: food.donorName,
      requesterEmail: req.firebaseUser.email,
      requestedQuantity: requestedQty,
      requestDate: new Date(),
      status: "pending", // pending, accepted, rejected, completed
      userNotes: userNotes || "",
      location: food.location,
      expirationDate: food.expirationDate
    };

    await requestsCollection.insertOne(requestRecord);

    // Create notification for donor
    await notificationsCollection.insertOne({
      recipientEmail: food.donorEmail,
      type: 'food_requested',
      message: `${req.firebaseUser.email} has requested ${requestedQty} portion(s) of your food: ${food.foodName}`,
      foodId: food._id,
      foodName: food.foodName,
      requesterEmail: req.firebaseUser.email,
      requestedQuantity: requestedQty,
      isRead: false,
      createdAt: new Date()
    });

    res.send({ 
      success: true, 
      result, 
      remainingQuantity: newQuantity,
      message: `Successfully requested ${requestedQty} portion(s). ${newQuantity} portion(s) remaining.`
    });
  } catch (error) {
    console.error("Error in request endpoint:", error);
    res.status(500).send({ error: "Failed to process request" });
  }
});

// this is /manage-my-food
app.get("/manage-my-food", verifyFirebaseToken, async (req, res) => {
  const query = { donorEmail: req.firebaseUser.email }
  const data = await foodsCollection
    .find(query)
    .toArray();
  res.send(data)
})

// Update food item (PUT /update-food/:id)
app.put("/update-food/:id", verifyFirebaseToken, async (req, res) => {
  try {
    const foodId = new ObjectId(req.params.id);
    const { foodName, foodImage, quantity, expirationDate, location, notes } = req.body;
    
    // Verify the user is the owner
    const food = await foodsCollection.findOne({ _id: foodId });
    if (!food) {
      return res.status(404).send({ error: "Food not found" });
    }
    
    if (food.donorEmail !== req.firebaseUser.email) {
      return res.status(403).send({ error: "Unauthorized: You can only update your own food items" });
    }

    const updateDoc = {
      $set: {
        foodName,
        foodImage,
        quantity,
        expirationDate,
        location,
        notes,
        updatedAt: new Date()
      }
    };

    const result = await foodsCollection.updateOne({ _id: foodId }, updateDoc);
    res.send(result);
  } catch (error) {
    console.error("Error updating food:", error);
    res.status(500).send({ error: "Failed to update food" });
  }
});

//This is for /request-food page - UPDATED TO USE REQUESTS COLLECTION
app.get("/my-food-request", verifyFirebaseToken, async (req, res) => {
  const userEmail = req.firebaseUser.email;

  try {
    const data = await requestsCollection
      .find({
        requesterEmail: userEmail
      })
      .sort({ requestDate: -1 })
      .toArray();

    res.send(data);
  } catch (error) {
    console.error("Error fetching requests:", error);
    res.status(500).send({ error: "Failed to fetch requests" });
  }
});

// Cancel request API (PATCH) - UPDATED FOR QUANTITY-BASED REQUESTS
app.patch("/cancel-request/:id", verifyFirebaseToken, async (req, res) => {
  try {
    const requestId = new ObjectId(req.params.id);
    
    // Find the request
    const request = await requestsCollection.findOne({ _id: requestId });
    
    if (!request) {
      return res.status(404).send({ error: "Request not found" });
    }

    // Verify the user is the requester
    if (request.requesterEmail !== req.firebaseUser.email) {
      return res.status(403).send({ error: "Unauthorized" });
    }

    // Return the quantity back to the food item
    const foodQuery = { _id: new ObjectId(request.foodId) };
    const food = await foodsCollection.findOne(foodQuery);
    
    if (food) {
      const currentQty = parseInt(food.quantity);
      const returnedQty = parseInt(request.requestedQuantity);
      const newQuantity = currentQty + returnedQty;

      await foodsCollection.updateOne(foodQuery, {
        $set: {
          quantity: newQuantity.toString(),
          status: "available" // Make it available again
        }
      });
    }

    // Delete the request record
    const result = await requestsCollection.deleteOne({ _id: requestId });
    
    res.send({ 
      success: true, 
      result,
      message: "Request cancelled successfully. Quantity returned to food item."
    });
  } catch (error) {
    console.error("Error cancelling request:", error);
    res.status(500).send({ error: "Failed to cancel request" });
  }
});

// ========== REQUESTS MANAGEMENT ENDPOINTS ==========

// Get all requests received by donor (food owner)
app.get("/my-received-requests", verifyFirebaseToken, async (req, res) => {
  console.log("hadfjas");
  
  try {
    const requests = await requestsCollection
      .find({ donorEmail: req.firebaseUser.email })
      .sort({ requestDate: -1 })
      .toArray();
    res.send(requests);
  } catch (error) {
    console.error("Error fetching received requests:", error);
    res.status(500).send({ error: "Failed to fetch received requests" });
  }
});

// Get all requests for a specific food item
app.get("/food-requests/:foodId", verifyFirebaseToken, async (req, res) => {
  try {
    const foodId = new ObjectId(req.params.foodId);
    const requests = await requestsCollection
      .find({ foodId: foodId })
      .sort({ requestDate: -1 })
      .toArray();
    res.send(requests);
  } catch (error) {
    console.error("Error fetching food requests:", error);
    res.status(500).send({ error: "Failed to fetch food requests" });
  }
});

// Update request status (accept/reject/complete)
app.patch("/request-status/:id", verifyFirebaseToken, async (req, res) => {
  try {
    const { status } = req.body; // pending, accepted, rejected, completed
    const requestId = new ObjectId(req.params.id);
    
    const result = await requestsCollection.updateOne(
      { _id: requestId },
      { $set: { status: status } }
    );
    
    res.send({ success: true, result });
  } catch (error) {
    console.error("Error updating request status:", error);
    res.status(500).send({ error: "Failed to update request status" });
  }
});

// ========== NOTIFICATIONS ENDPOINTS ==========

// Get notifications for current user
app.get("/notifications", verifyFirebaseToken, async (req, res) => {
  try {
    const notifications = await notificationsCollection
      .find({ recipientEmail: req.firebaseUser.email })
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray();
    res.send(notifications);
  } catch (error) {
    console.error("Error fetching notifications:", error);
    res.status(500).send({ error: "Failed to fetch notifications" });
  }
});

// Get unread notification count
app.get("/notifications/unread-count", verifyFirebaseToken, async (req, res) => {
  try {
    const count = await notificationsCollection.countDocuments({
      recipientEmail: req.firebaseUser.email,
      isRead: false
    });
    res.send({ count });
  } catch (error) {
    console.error("Error fetching unread count:", error);
    res.status(500).send({ error: "Failed to fetch unread count" });
  }
});

// Mark notification as read
app.patch("/notifications/:id/read", verifyFirebaseToken, async (req, res) => {
  try {
    const query = { _id: new ObjectId(req.params.id) };
    const updateDoc = { $set: { isRead: true } };
    const result = await notificationsCollection.updateOne(query, updateDoc);
    res.send(result);
  } catch (error) {
    console.error("Error marking notification as read:", error);
    res.status(500).send({ error: "Failed to mark as read" });
  }
});

// Mark all notifications as read
app.patch("/notifications/mark-all-read", verifyFirebaseToken, async (req, res) => {
  try {
    const result = await notificationsCollection.updateMany(
      { recipientEmail: req.firebaseUser.email, isRead: false },
      { $set: { isRead: true } }
    );
    res.send(result);
  } catch (error) {
    console.error("Error marking all as read:", error);
    res.status(500).send({ error: "Failed to mark all as read" });
  }
});

// Delete notification
app.delete("/notifications/:id", verifyFirebaseToken, async (req, res) => {
  try {
    const query = { _id: new ObjectId(req.params.id) };
    const result = await notificationsCollection.deleteOne(query);
    res.send(result);
  } catch (error) {
    console.error("Error deleting notification:", error);
    res.status(500).send({ error: "Failed to delete notification" });
  }
});

// ========== ANALYTICS ENDPOINTS ==========

// Get user analytics - UPDATED FOR QUANTITY-BASED REQUESTS
app.get("/analytics/user", verifyFirebaseToken, async (req, res) => {
  try {
    const userEmail = req.firebaseUser.email;
    
    // Total foods donated
    const totalDonated = await foodsCollection.countDocuments({
      donorEmail: userEmail
    });
    
    // Total requests made by user (from requests collection)
    const totalRequested = await requestsCollection.countDocuments({
      requesterEmail: userEmail
    });
    
    // Foods currently available from user
    const availableFoods = await foodsCollection.countDocuments({
      donorEmail: userEmail,
      status: "available"
    });
    
    // Total quantity donated (sum of all food quantities)
    const totalQuantityDonated = await foodsCollection.aggregate([
      { $match: { donorEmail: userEmail } },
      { $group: { _id: null, total: { $sum: { $toInt: "$quantity" } } } }
    ]).toArray();

    // Requests received on user's donated food
    const requestsReceived = await requestsCollection.countDocuments({
      donorEmail: userEmail
    });
    
    res.send({
      totalDonated,
      totalRequested,
      availableFoods,
      requestsReceived,
      totalQuantityDonated: totalQuantityDonated[0]?.total || 0
    });
  } catch (error) {
    console.error("Error fetching user analytics:", error);
    res.status(500).send({ error: "Failed to fetch analytics" });
  }
});

// Get global analytics (platform-wide stats)
app.get("/analytics/global", async (req, res) => {
  try {
    // Total foods in system
    const totalFoods = await foodsCollection.countDocuments({});
    
    // Available foods
    const availableFoods = await foodsCollection.countDocuments({
      status: "available"
    });
    
    // Requested foods
    const requestedFoods = await foodsCollection.countDocuments({
      status: "requested"
    });
    
    // Top donors
    const topDonors = await foodsCollection.aggregate([
      {
        $group: {
          _id: "$donorEmail",
          donorName: { $first: "$donorName" },
          totalDonations: { $sum: 1 }
        }
      },
      { $sort: { totalDonations: -1 } },
      { $limit: 5 }
    ]).toArray();
    
    // Food distribution by location
    const foodsByLocation = await foodsCollection.aggregate([
      {
        $group: {
          _id: "$location",
          count: { $sum: 1 }
        }
      },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]).toArray();
    
    res.send({
      totalFoods,
      availableFoods,
      requestedFoods,
      topDonors,
      foodsByLocation
    });
  } catch (error) {
    console.error("Error fetching global analytics:", error);
    res.status(500).send({ error: "Failed to fetch global analytics" });
  }
});

// delete food
app.delete('/manage-my-food/:id', async (req, res) => {
  const id = req.params.id;

  
  if (!ObjectId.isValid(id)) {
    return res.status(400).json({ error: "Invalid ID format" });
  }

  const query = { _id: new ObjectId(id) };

  try {
    const result = await foodsCollection.deleteOne(query);
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "Food item not found" });
    }
    res.send({ message: "Deleted successfully", deletedCount: result.deletedCount });
  } catch (error) {
    console.error("Delete error:", error);
    res.status(500).json({ error: "Server error while deleting" });
  }
});

// Initialize the database connection
connectToDatabase().catch(console.dir);

// Export the app for Vercel
module.exports = app;

// Only start the server if running locally (not on Vercel)
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`);
  });
}
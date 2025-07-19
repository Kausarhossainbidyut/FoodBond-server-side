const express = require("express");
const cors = require("cors");

const { MongoClient, ServerApiVersion, ObjectId, ChangeStream } = require("mongodb");
const dotenv = require("dotenv");
dotenv.config();

const admin = require("firebase-admin");

const serviceAccount = require("./admin-key.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});



// const serviceAccount = require("./admin-key.json");

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

// middleware/auth.js

const verifyFirebaseToken = async (req, res, next) => {
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


async function run() {
  try {
    await client.connect();
    const db = client.db("assignment11");
    const foodsColectin = db.collection("foods");

    //This is for /add-food page
    app.post('/add-food', async (req, res) => {
      const data = req.body;
      const result = await foodsColectin.insertOne(data)
      res.send(result)
    })

    //This is for /home/featured-foods page
    app.get("/featured-foods", async (req, res) => {
      try {
        const data = await foodsColectin.aggregate([
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
      const data = await foodsColectin
        .find({ status: "available" })
        .sort({ expirationDate: 1 })
        .toArray();
      res.send(data)
    })

    //This for /food-details/:foodId
    app.get("/food-details/:id", async (req, res) => {
      const query = { _id: new ObjectId(req.params.id) }
      const data = await foodsColectin.findOne(query)
      res.send(data)
    })

    //this is for register/:id
    app.patch("/request/:id", verifyFirebaseToken, async (req, res) => {
      const { userNotes } = req.body;
      const query = { _id: new ObjectId(req.params.id) };

      const updateDoc = {
        $set: {
          status: "requested",
          requestDate: new Date(),
          requestedBy: req.firebaseUser.email,
          userNotes: userNotes || ""
        },
      };

      const result = await foodsColectin.updateOne(query, updateDoc);
      res.send(result);
    });


    // this is /manage-my-food
    app.get("/manage-my-food", verifyFirebaseToken, async (req, res) => {
      const query = { donorEmail: req.firebaseUser.email }
      const data = await foodsColectin
        .find(query)
        .toArray();
      res.send(data)
    })

    //This is for /request-food page
    app.get("/my-food-request", verifyFirebaseToken, async (req, res) => {
      const userEmail = req.firebaseUser.email;

      try {
        const data = await foodsColectin
          .find({
            status: "requested",
            requestedBy: userEmail, // নিজের ইমেইলের সাথে মিল
          })
          .sort({ expirationDate: 1 })
          .toArray();

        res.send(data);
      } catch (error) {
        console.log(error);
      }
    });

    // Cancel request API (PATCH)
    app.patch("/cancel-request/:id", verifyFirebaseToken, async (req, res) => {
      const { userNotes } = req.body;
      const query = { _id: new ObjectId(req.params.id) };
      const updateDoc = {
        $set: {
          status: "available",
          requestedBy: null,          // important: clear requestedBy on cancel
          userNotes: userNotes || "",
        },
      };
      const result = await foodsColectin.updateOne(query, updateDoc);
      res.send(result);
    });





    // Send a ping to confirm a successful connection
    console.log("✅ Pinged your deployment. You successfully connected to MongoDB!");
  } finally {
  }
}

run().catch(console.dir);



// Root route


app.get("/", verifyFirebaseToken, async (req, res) => {
  // const token =req.headers?.authorization.split(' ')[1]
  // console.log(verifyFirebaseToken);

  res.send("Server is running!");
});



app.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});


/*
1. send token from client side
2. receive from server
3. decode the token from server
*/
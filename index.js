const express = require('express');
const app = express();
const cors = require('cors');
const port = process.env.PORT || 5000;
require('dotenv').config()
let jwt = require('jsonwebtoken');
const stripe = require('stripe')(process.env.PAYMENT_SECRET_KEY);

//middleware
app.use(cors({
    origin: ['https://storied-stardust-becd39.netlify.app','http://localhost:5173'],
    credentials: true,
    optionSuccessStatus: 200
  }));
app.use(express.json());

const verifyJWt = (req, res, next) => {
    const authorization = req.headers.authorization;
    if (!authorization) {
        return res.status(401).send({ error: true, message: 'unauthorizedd access' });
    }

    // bearer token
    const token = authorization.split(' ')[1];

    jwt.verify(token, process.env.ACCESS_TOKEN, (err, decoded) => {
        if (err) {
            return res.status(401).send({ error: true, message: 'unauthorized access' })
        }
        req.decoded = decoded;
        next();
    })
};


const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const client = new MongoClient(`${process.env.DB_URI}`, {
    serverApi: {
      version: ServerApiVersion.v1,
      strict: true,
      deprecationErrors: true,
    }
  });

async function run() {
    try {
        // Connect the client to the server	(optional starting in v4.7)
        await client.connect();

        // Get the database and collection on which to run the operation
        const usersCollection = client.db("Restaurant").collection("users");
        const menuCollection = client.db("Restaurant").collection("menu");
        const reviewsCollection = client.db("Restaurant").collection("reviews");
        const cartCollection = client.db("Restaurant").collection("carts");
        const paymentCollection = client.db("Restaurant").collection("payments");

        //jwt token set 
        app.post('/jwt', (req, res) => {
            const user = req.body;
            const token = jwt.sign(user, process.env.ACCESS_TOKEN, { expiresIn: '5h' });
            res.send({ token })
        })


        //use verifyJWT before using verifyAdmin
        const verifyAdmin = async (req, res, next) => {
            const email = req.decoded.email;
            const query = { email: email }
            const user = await usersCollection.findOne(query);
            if (user?.role !== 'admin') {
                return res.status(403).send({ error: true, message: 'forbidden message' });
            }
            next();
        }



        //user related apis
        app.get(`/users`, verifyJWt, verifyAdmin, async (req, res) => {
            const result = await usersCollection.find().toArray();
            res.send(result);
        })

        app.post('/users', async (req, res) => {
            const user = req.body;
            const query = { email: user.email };
            const existingUser = await usersCollection.findOne(query);

            if (existingUser) {
                return res.send({ message: 'User already exists' })
            }

            const result = await usersCollection.insertOne(user);
            res.send(result);
        })

        //security layer: verifyJWT, check email and check if admin
        app.get('/users/admin/:email', verifyJWt, async (req, res) => {
            const email = req.params.email;

            if (req.decoded.email !== email) {
                res.send({ admin: false })
            }

            const query = { email: email };
            const user = await usersCollection.findOne(query);
            const result = { admin: user?.role === 'admin' };
            res.send(result);
        })

        app.patch('/users/admin/:id', async (req, res) => {
            const id = req.params.id;
            const filter = { _id: new ObjectId(id) };
            const updateDoc = {
                $set: {
                    role: 'admin'
                }
            };

            const result = await usersCollection.updateOne(filter, updateDoc);
            res.send(result);
        });

        //menu api
        app.get('/menu', async (req, res) => {
            const result = await menuCollection.find().toArray();
            res.send(result);
        })

        app.post('/menu', verifyJWt, verifyAdmin, async (req, res) => {
            const newItem = req.body;
            const result = await menuCollection.insertOne(newItem);
            res.send(result);
        });

        app.delete('/menu/:id', verifyJWt, verifyAdmin, async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const result = await menuCollection.deleteOne(query);
            res.send(result);
        });

        //review api
        app.get('/reviews', async (req, res) => {
            // await reviewsCollection.insertMany()
            const result = await reviewsCollection.find().toArray();
            res.send(result);
        })


        //cart collection
        app.get('/carts', verifyJWt, async (req, res) => {
            const email = req.query.email;
            if (!email) {
                res.send([]);
            }

            const decodedEmail = req.decoded.email;
            if (email !== decodedEmail) {
                return res.status(403).send({ error: true, message: 'forbidden access' })
            }

            const query = { email: email };
            const result = await cartCollection.find(query).toArray();
            res.send(result);
        })

        app.post('/carts', async (req, res) => {
            const item = req.body;
            const result = await cartCollection.insertOne(item);
            res.send(result);
        })

        app.delete('/carts/:id', async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const result = await cartCollection.deleteOne(query);
            res.send(result);

        });


        //payment intents
        app.post("/create-payment-intent", verifyJWt, async (req, res) => {
            const { price } = req.body;
            const amount = parseInt(price * 100);
            const paymentIntent = await stripe.paymentIntents.create({
                amount: amount,
                currency: "usd",
                payment_method_types: ['card']
            });

            res.send({
                clientSecret: paymentIntent.client_secret,
            })
        })

        //payment apis
        app.post('/payments', verifyJWt, async (req, res) => {
            const payment = req.body;
            const insertResult = await paymentCollection.insertOne(payment);
            const query = { _id: { $in: payment.cartItems.map(id => new ObjectId(id)) } }
            const deleteResult = await cartCollection.deleteMany(query)

            res.send({ insertResult, deleteResult });
        });

        //admin stats 
        app.get('/admin-stats', verifyJWt, verifyAdmin, async (req, res) => {
            const users = await usersCollection.estimatedDocumentCount();
            const products = await menuCollection.estimatedDocumentCount();
            const orders = await paymentCollection.estimatedDocumentCount();

            const payments = await paymentCollection.find().toArray();
            const revenue = payments.reduce((sum, payment) => sum + payment.price, 0)
            res.send({ users, products, orders, revenue });
        })

        //agregate pipeline
        app.get('/order-stats', verifyJWt, verifyAdmin, async (req, res) => {
            const pipeline = [
                {
                    $lookup: {
                        from: 'menu',
                        localField: 'menuItems',
                        foreignField: '_id',
                        as: 'menuItemsData'
                    }
                },
                {
                    $unwind: '$menuItemsData'
                },
                {
                    $group: {
                        _id: '$menuItemsData.category',
                        count: { $sum: 1 },
                        total: { $sum: '$menuItemsData.price' }
                    }
                },
                {
                    $project: {
                        category: '$_id',
                        count: 1,
                        total: { $round: ['$total', 2] },
                        _id: 0
                    }
                }
            ];

            const result = await paymentCollection.aggregate(pipeline).toArray()
            res.send(result)

        })



        // Send a ping to confirm a successful connection
        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } finally {
        // Ensures that the client will close when you finish/error
        // await client.close();
    }
}
run().catch(console.dir);



app.get('/', (req, res) => {
    res.send('bistro server running');
})


app.listen(port, () => {
    console.log(`listening on port ${port}`);
});
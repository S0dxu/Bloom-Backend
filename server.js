require('dotenv').config();
const port = process.env.PORT;
const express = require('express');
const app = express();
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const path = require('path');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const fuzzy = require('fuzzy');
const fs = require('fs');

app.use(express.json());
app.use(cors());

mongoose.connect(process.env.MONGODB_URI);

app.get("/", (req, res) => {
  res.send("Express is running");
});

const fetchUser = async (req, res, next) => {
  const token = req.header('auth-token');
  if (!token) {
    return res.status(401).send({ errors: "Please authenticate using valid token" });
  }
  try {
    const data = jwt.verify(token, process.env.JWT_SECRET);
    req.user = data.user;
    if (!req.user.id) {
      throw new Error('Invalid token payload');
    }
    next();
  } catch (error) {
    console.error(error);
    res.status(401).send({ errors: "Please authenticate using valid token" });
  }
};

const Product = mongoose.model("Product", {
  id: { type: Number, required: true },
  name: { type: String, required: true },
  images: { type: [String], default: [] },
  category: { type: String, required: true },
  new_price: { type: Number, required: true },
  old_price: { type: Number, required: true },
  sizes: [{
    name: { type: String, required: true },
    quantity: { type: Number, required: true }
  }],
  date: { type: Date, default: Date.now },
  available: { type: Boolean, default: true }
});

app.get("/searchproducts", async (req, res) => {
  const query = req.query.query.toLowerCase();
  if (!query) {
    return res.status(400).json({ success: false, message: "Query is required" });
  }
  try {
    let products = await Product.find({ name: { $regex: query, $options: 'i' } });
    if (products.length === 0) {
      let allProducts = await Product.find({});
      let names = allProducts.map(product => product.name);
      let results = fuzzy.filter(query, names);
      let matchedProductNames = results.map(result => result.string);
      products = allProducts.filter(product => matchedProductNames.includes(product.name));
    }
    res.json({ success: true, products });
  } catch (error) {
    console.error("Error searching products:", error);
    res.status(500).send({ error: "Server Error" });
  }
});

app.get("/allproducts", async (req, res) => {
  try {
    let products = await Product.find({}).sort({ name: 1 });
    res.send(products);
  } catch (error) {
    console.error("Error fetching products:", error);
    res.status(500).send({ error: "Server Error" });
  }
});

const Users = mongoose.model("Users", new mongoose.Schema({
  name: { type: String },
  email: { type: String, unique: true },
  password: { type: String },
  cartData: { type: Object },
  date: { type: Date, default: Date.now },
  favorites: { type: [Number], default: [] }
}, { versionKey: false }));

app.get('/getuser', fetchUser, async (req, res) => {
  try {
    const user = await Users.findOne({ _id: req.user.id });
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    res.json({ success: true, user: { name: user.name, email: user.email, date: user.date } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.post("/signup", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ success: false, errors: "All fields are required" });
  }
  let check = await Users.findOne({ email });
  if (check) {
    return res.status(400).json({ success: false, errors: "Existing user found with the same email" });
  }
  let cart = {};
  for (let i = 0; i < 300; i++) {
    cart[i] = 0;
  }
  const user = new Users({
    name,
    email,
    password,
    cartData: cart
  });
  await user.save();
  const data = {
    user: { id: user.id }
  };
  const token = jwt.sign(data, process.env.JWT_SECRET);
  res.json({ success: true, token });
});

app.post('/login', async (req, res) => {
  let user = await Users.findOne({ email: req.body.email });
  if (user) {
    const passCompare = req.body.password === user.password;
    if (passCompare) {
      const data = { user: { id: user.id } };
      const token = jwt.sign(data, process.env.JWT_SECRET);
      res.json({ success: true, token });
    } else {
      res.json({ success: false, errors: "Wrong Password" });
    }
  } else {
    res.json({ success: false, errors: "Wrong Email Id" });
  }
});

app.get("/newcollections", async (req, res) => {
  let products = await Product.find({});
  let newcollection = products.slice(1).slice(-8);
  res.send(newcollection);
});

app.get("/popularinwomen", async (req, res) => {
  let products = await Product.find({});
  let popular_in_women = products.slice(0, 4);
  res.send(popular_in_women);
});

app.post('/addtocart', fetchUser, async (req, res) => {
  try {
    let userData = await Users.findOne({ _id: req.user.id });
    const itemId = req.body.itemId;
    const size = req.body.size;
    if (!itemId || !size || isNaN(itemId)) {
      return res.status(400).json({ success: false, message: 'Invalid item ID or size' });
    }
    if (!userData.cartData) {
      userData.cartData = {};
    }
    const productKey = `${itemId}-${size}`;
    if (!userData.cartData[productKey] || isNaN(userData.cartData[productKey])) {
      userData.cartData[productKey] = 0;
    }
    userData.cartData[productKey] += 1;
    await Users.findOneAndUpdate({ _id: req.user.id }, { cartData: userData.cartData });
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.post('/removetocart', fetchUser, async (req, res) => {
  try {
    const { itemId, size } = req.body;
    let userData = await Users.findOne({ _id: req.user.id });
    if (!itemId || !size) {
      return res.status(400).json({ success: false, message: 'Invalid itemId or size' });
    }
    if (!userData.cartData) {
      userData.cartData = {};
    }
    const productKey = `${itemId}-${size}`;
    if (userData.cartData[productKey] && userData.cartData[productKey] > 0) {
      userData.cartData[productKey] -= 1;
    }
    await Users.findOneAndUpdate({ _id: req.user.id }, { cartData: userData.cartData });
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.post('/getcart', fetchUser, async (req, res) => {
  let userData = await Users.findOne({ _id: req.user.id });
  res.json(userData.cartData);
});

app.post('/addfavorite', fetchUser, async (req, res) => {
  try {
    const user = await Users.findOne({ _id: req.user.id });
    if (!user.favorites.includes(req.body.itemId)) {
      user.favorites.push(req.body.itemId);
      await user.save();
      res.json({ success: true, message: 'Added to favorites.' });
    } else {
      res.json({ success: false, message: 'Already in favorites.' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

app.post('/removefavorite', fetchUser, async (req, res) => {
  try {
    const user = await Users.findOne({ _id: req.user.id });
    user.favorites = user.favorites.filter(itemId => itemId !== req.body.itemId);
    await user.save();
    res.json({ success: true, message: 'Removed from favorites.' });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

app.get('/getfavorites', fetchUser, async (req, res) => {
  try {
    const user = await Users.findOne({ _id: req.user.id });
    res.json(user.favorites);
  } catch (error) {
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

app.put('/updateprofile', fetchUser, async (req, res) => {
  const { name, email } = req.body;
  try {
    const updatedUser = await Users.findByIdAndUpdate(
      req.user.id,
      { $set: { name, email } },
      { new: true }
    );
    res.json({ success: true, user: updatedUser });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.post('/create-payment-intent', async (req, res) => {
  const { amount, currency } = req.body;
  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency,
      payment_method_types: ['card']
    });
    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`server running on port ${PORT}`);
  });
}

module.exports = app;

const { Client, Intents } = require("discord.js");
const path = require("path");
const util = require("util");
const { MongoClient, ServerApiVersion } = require("mongodb");
const fs = require("fs");
const crypto = require("crypto");
const { PassThrough } = require("stream");
const ndjson = require("ndjson");
const { google } = require("googleapis");
const firebaseAdmin = require("firebase-admin");

firebaseAdmin.initializeApp({
  credential: firebaseAdmin.credential.cert(
    require("./.data/credentials/service-account.json")
  ),
  databaseURL:
    "https://showdownspace-default-rtdb.asia-southeast1.firebasedatabase.app",
});
const googleAuth = new google.auth.GoogleAuth({
  keyFile: "./.data/credentials/service-account.json",
  scopes: ["https://www.googleapis.com/auth/drive"],
});
google.options({ auth: googleAuth });
const unscopedGoogleAuth = new google.auth.GoogleAuth({
  keyFile: "./.data/credentials/service-account.json",
});

require("source-map-support").install();

const loggly = require("node-loggly-bulk").createClient({
  token: process.env.LOGGLY_TOKEN,
  subdomain: process.env.LOGGLY_SUBDOMAIN,
  tags: ["showdownspace-bot"],
  json: true,
});

// Require the fastify framework and instantiate it
const logStream = new PassThrough();
logStream.pipe(process.stdout);
logStream.pipe(ndjson.parse({ strict: false })).on("data", (m) => {
  loggly.log(m);
});
const fastify = require("fastify")({
  // set this to true for detailed logging:
  logger: {
    stream: logStream,
  },
  bodyLimit: 10 * 1048576,
});
const log = fastify.log;

let latestDeployment;
fs.mkdirSync(".data/blobs", { recursive: true });
if (fs.existsSync(".data/latest_deployment")) {
  latestDeployment = fs.readFileSync(".data/latest_deployment", "utf8");
  log.info("Latest deployment found.");
} else {
  log.info("No deployment found.");
}

async function loadLatestDeployment() {
  const file = fs.realpathSync(
    ".data/deployments/" + latestDeployment + "/index.js"
  );
  return require(file);
}

// MongoDB
const mongo = new MongoClient(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverApi: ServerApiVersion.v1,
});
mongo.connect();
const db = mongo.db();

// Discord
const client = new Client({
  intents: [
    Intents.FLAGS.GUILDS,
    Intents.FLAGS.GUILD_MESSAGES,
    Intents.FLAGS.GUILD_MEMBERS,
    Intents.FLAGS.GUILD_PRESENCES,
    Intents.FLAGS.DIRECT_MESSAGES,
  ],
  partials: ["CHANNEL"],
});
client.once("ready", () => {
  console.log("Ready!");
});
const discordToken = process.env.DISCORD_TOKEN;
client.login(discordToken);
const context = {
  processState: {},
  client,
  db,
  fastify,
  discordToken,
  log,
  firebaseAdmin,
  google,
  googleAuth,
  unscopedGoogleAuth,
};

client.on("interactionCreate", async (interaction) => {
  const logic = await loadLatestDeployment();
  return logic.handleInteraction(context, interaction);
});
client.on("messageCreate", async (message) => {
  const logic = await loadLatestDeployment();
  return logic.handleMessage(context, message);
});

// Setup our static files
fastify.register(require("fastify-static"), {
  root: path.join(__dirname, "public"),
  prefix: "/", // optional: default '/'
});

// fastify-formbody lets us parse incoming forms
fastify.register(require("fastify-formbody"));

// point-of-view is a templating manager for fastify
fastify.register(require("point-of-view"), {
  engine: {
    handlebars: require("handlebars"),
  },
});

function raise(code, message) {
  const err = new Error(message);
  err.statusCode = code;
  throw err;
}

fastify.post("/deploy", async (request, reply) => {
  if (request.body.token !== process.env.CODE_DEPLOY_TOKEN) {
    raise(401, "Invalid deploy key");
  }
  for (const { filename, data, hash } of request.body.files) {
    const blobPath = `.data/blobs/${hash}`;
    if (data == null && !fs.existsSync(blobPath)) {
      raise(400, "Missing data for hash " + hash);
    }
    if (data != null) {
      fs.writeFileSync(blobPath, data, "utf8");
    }
  }
  const hashes = request.body.files.map((f) => f.hash).sort();
  const deploymentHash = crypto
    .createHash("sha256")
    .update(hashes.join(","))
    .digest("hex");
  const deploymentPath = `.data/deployments/${deploymentHash}`;
  fs.mkdirSync(deploymentPath, { recursive: true });
  for (const { filename, data, hash } of request.body.files) {
    const blobPath = `.data/blobs/${hash}`;
    try {
      fs.linkSync(blobPath, `${deploymentPath}/${filename}`);
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
    }
  }
  fs.writeFileSync(".data/latest_deployment", deploymentHash);
  latestDeployment = deploymentHash;
  return "meow";
});

fastify.all("/showdown", async (request, reply) => {
  const logic = await loadLatestDeployment();
  return logic.handleHttpRequest(context, request, reply);
});

// Our main GET home page route, pulls from src/pages/index.hbs
fastify.get("/", function (request, reply) {
  // params is an object we'll pass to our handlebars template
  let params = {
    greeting: "Hello Node!",
  };
  // request.query.paramName <-- a querystring example
  reply.view("/src/pages/index.hbs", params);
});

// A POST route to handle form submissions
fastify.post("/", function (request, reply) {
  let params = {
    greeting: "Hello Form!",
  };
  // request.body.paramName <-- a form post example
  reply.view("/src/pages/index.hbs", params);
});

// Run the server and report out to the logs
fastify.listen(process.env.PORT, "0.0.0.0", function (err, address) {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
  console.log(`Your app is listening on ${address}`);
  fastify.log.info(`server listening on ${address}`);
});

// Entry point for running the app, Discord bot, and Telegram bot
const { start } = require("./src/app.js");
start();

require("./discord/index.js");

require("./telegram/index.js");
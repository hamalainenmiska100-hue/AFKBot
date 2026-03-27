# AFKBot

AFKBot is a Discord bot that connects to a Minecraft server on your behalf, allowing you to stay AFK (away from keyboard) while performing other tasks. The bot can execute commands when it connects to the server, manage connection settings, and handle reconnections automatically. This is particularly useful for tasks like farming, waiting for in-game events, or simply maintaining your presence on the server.

## Requirements

- Node.js (v22.0.0 or higher)
- Discord Bot Token
- Own Discord server (for interaction panel)
- Microsoft account for Bedrock authentication flow

## Installation

1. **Clone the Repository**

    ```bash
    git clone https://github.com/NightMirror21/AFKBot.git
    cd AFKBot
    ```
    
2. **Configure your bot**

    Set your bot token as an environment variable before running:

    ```bash
    export DISCORD_TOKEN=your_discord_bot_token
    ```

3. **Install dependencies**
    
    ```bash
    npm install
    ```

4. **Run**

    ```bash
    node bot.js
    ```

## Usage
Once the bot is running, you can control it through the following Discord commands:

- `/settings <host> <port> <username>` - Sets the connection settings for the Minecraft server.
  ```
  host: The IP address of the Minecraft server.
  port: The port number of the Minecraft server.
  username: The username you want to connect with.
  ```

- `/connect` - Connects the bot to the Minecraft server using the previously set settings.

- `/disconnect` - Disconnects the bot from the Minecraft server.

- `/setcommand <command>` - Sets a command that the bot will execute upon connecting to the server. This is useful for logging in with a password or performing any other in-game tasks.
  ```
  command: The Minecraft command to execute.
  ```

- `/setdelay <delay_in_seconds>` - Sets the delay before the bot attempts to reconnect to the server if disconnected.
  ```
  delay_in_seconds: The number of seconds to wait before attempting to reconnect.
  ```

- `/help` - Displays a help message with detailed instructions on how to use the bot.

### Example
1. Set up the server connection settings:
`/settings play.example.com 25565 MyUsername`
2. Connect to the server:
`/connect`
3. Set a command to be executed upon connection (e.g., logging in):
`/setcommand /login MySecretPassword`
4. Set a custom delay before reconnecting:
`/setdelay 10`
5. Disconnect from the server:
`/disconnect`

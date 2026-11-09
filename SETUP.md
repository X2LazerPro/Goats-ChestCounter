# Optional upgrades (database + Discord login)

Nothing here is required. With none of it set up, the lobby works like before.
Add each part when you want it, in Render: your service > **Environment** > **Add Environment Variable**.

## A) Database (keeps counts for a long time, survives the server sleeping)
1. Make a free account at **neon.tech** (or supabase.com).
2. Create a project. Copy the **connection string** (starts with `postgresql://`).
3. In Render add:  `DATABASE_URL` = that connection string.
4. Optional: `KEEP_DAYS` = how many days to remember inactive players (default 365, `0` = forever).

## B) Log in with Discord
1. Go to **discord.com/developers/applications** > **New Application**.
2. Open **OAuth2**. Copy the **Client ID**. Click **Reset Secret** and copy the **Client Secret**.
3. Under **Redirects** add exactly:  `https://lobby-fn.onrender.com/auth/discord/callback`  then Save.
4. In Render add:  `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET`.

## C) Update the server
Upload the new files to your GitHub repo (**package.json**, **server.js**, **index.html**). Render redeploys by itself.
Then open `https://lobby-fn.onrender.com/api/status` - it should show `{"db":true,"discord":true}` for the parts you set up.

## Using it
- Site: tap **Log in with Discord** once. Your name comes from Discord and your counts follow your account to any phone or PC.
- Windows app: right-click > **Link Discord account...** (a browser tab opens, log in, done).
- Don't share your `settings.ini` - it contains your login token.

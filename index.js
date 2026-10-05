import { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, EmbedBuilder, ChannelType, ActivityType, VoiceBasedChannel } from "discord.js";
import { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, StreamType, entersState } from "@discordjs/voice";
import type { ChildProcessWithoutNullStreams } from "child_process";
import { YtDlp, helpers } from "ytdlp-nodejs";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// User wallets (in-memory; use a database for persistence)
const wallets = new Map<string, number>();
const BASE_BALANCE = 1000;

// Blacklist storage
const blacklist = new Set<string>();

// Music player state
const musicQueue = new Map<string, string[]>();
const nowPlaying = new Map<string, string>();
const voiceConnections = new Map<string, any>();
const audioPlayers = new Map<string, ReturnType<typeof createAudioPlayer>>();
const currentResources = new Map<string, any>();
const ytDlpProcesses = new Map<string, ChildProcessWithoutNullStreams>();
const musicVolumes = new Map<string, number>();
let ytdlp: YtDlp | null = null;

// Your Discord username for admin check
const ADMIN_USERNAME = "im.miserable";

// Commands
const commands = [
  new SlashCommandBuilder()
    .setName("balance")
    .setDescription("Check your current balance"),
  new SlashCommandBuilder()
    .setName("bet")
    .setDescription("Flip a coin and bet currency")
    .addIntegerOption((opt) =>
      opt.setName("amount").setDescription("Amount to bet").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("roll")
    .setDescription("Roll a d20 and win based on the result")
    .addIntegerOption((opt) =>
      opt.setName("amount").setDescription("Amount to bet").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("verify")
    .setDescription("Verify user identity with a security code"),
  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("View top players by balance"),
  new SlashCommandBuilder()
    .setName("setcurrency")
    .setDescription("⚙️ ADMIN ONLY - Set a user's currency balance")
    .addStringOption((opt) =>
      opt.setName("user_id").setDescription("Discord user ID").setRequired(true)
    )
    .addIntegerOption((opt) =>
      opt.setName("amount").setDescription("Amount to set").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("removeallroles")
    .setDescription("⚙️ ADMIN ONLY - Remove all roles from a user")
    .addStringOption((opt) =>
      opt.setName("user_id").setDescription("Discord user ID").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("purge")
    .setDescription("⚙️ ADMIN ONLY - Delete messages in this channel")
    .addIntegerOption((opt) =>
      opt.setName("amount").setDescription("Number of messages to delete (1-100)").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Add a song to the queue and play it")
    .addStringOption((opt) =>
      opt.setName("song").setDescription("Song name, artist, or YouTube URL").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("queue")
    .setDescription("View the current music queue"),
  new SlashCommandBuilder()
    .setName("skip")
    .setDescription("Skip to the next song"),
  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Stop music and disconnect"),
  new SlashCommandBuilder()
    .setName("pause")
    .setDescription("Pause the current song"),
  new SlashCommandBuilder()
    .setName("resume")
    .setDescription("Resume the current song"),
  new SlashCommandBuilder()
    .setName("nowplaying")
    .setDescription("Show the song currently playing"),
  new SlashCommandBuilder()
    .setName("volume")
    .setDescription("Set music volume (0-100)")
    .addIntegerOption((opt) =>
      opt.setName("amount").setDescription("Volume percentage").setMinValue(0).setMaxValue(100).setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("blacklist")
    .setDescription("Manage user blacklist")
    .addSubcommand((sub) =>
      sub
        .setName("add")
        .setDescription("Add and ban a user from the server")
        .addStringOption((opt) =>
          opt.setName("user_id").setDescription("Discord user ID to blacklist and ban").setRequired(true)
        )
        .addStringOption((opt) =>
          opt.setName("reason").setDescription("Reason for ban").setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription("Remove a user from blacklist and unban them")
        .addStringOption((opt) =>
          opt.setName("user_id").setDescription("Discord user ID to remove").setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub.setName("list").setDescription("View current blacklist")
    ),
];

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN!);

// Update bot status with member count
const updateBotStatus = async () => {
  try {
    const guild = client.guilds.cache.first();
    if (!guild) return;

    // Use Discord's existing memberCount instead of fetching all members.
    // Fetching members sends Gateway opcode 8 requests and can be rate-limited.
    const totalMembers = guild.memberCount;

    client.user?.setActivity(`${totalMembers} members`, {
      type: ActivityType.Watching,
    });

    console.log(`Status updated: ${totalMembers} members`);
  } catch (error) {
    console.error("Error updating status:", error);
  }
};

// Music helpers
type SearchResult = {
  title: string;
  url: string;
};

const resolveSong = async (query: string): Promise<SearchResult | null> => {
  try {
    if (!ytdlp) throw new Error("Music engine is not initialized yet.");
    const target = /^https?:\/\//i.test(query) ? query : `ytsearch1:${query}`;

    const output = await ytdlp.execAsync(target, {
      noWarnings: true,
      skipDownload: true,
      noPlaylist: true,
      jsRuntime: "node",
      print: "%(title)s\t%(webpage_url)s",
    });

    const line = output
      .trim()
      .split(/\r?\n/)
      .find((value: string) => value.includes("\t"));

    if (!line) return null;

    const [title, url] = line.split("\t");
    if (!title || !url) return null;

    return { title, url };
  } catch (error) {
    console.error("Error resolving song:", error);
    return null;
  }
};

const stopYtDlp = (guildId: string) => {
  const process = ytDlpProcesses.get(guildId);

  if (process && !process.killed) {
    try {
      process.kill("SIGKILL");
    } catch {}
  }

  ytDlpProcesses.delete(guildId);
};

const cleanupMusic = (guildId: string) => {
  stopYtDlp(guildId);
  currentResources.delete(guildId);
  nowPlaying.delete(guildId);

  const connection = voiceConnections.get(guildId);

  try {
    connection?.destroy?.();
  } catch {}

  voiceConnections.delete(guildId);
  audioPlayers.delete(guildId);
};

const sendMusicMessage = async (guildId: string, content: string) => {
  const channel = client.channels.cache.find(
    (c) => c.isTextBased() && c.guildId === guildId
  );

  if (channel?.isTextBased()) {
    await channel.send(content).catch(() => {});
  }
};

const ensureVoice = async (guildId: string, channel: VoiceBasedChannel) => {
  let connection = voiceConnections.get(guildId);
  let player = audioPlayers.get(guildId);

  if (connection && connection.joinConfig.channelId !== channel.id) {
    cleanupMusic(guildId);
    connection = undefined;
    player = undefined;
  }

  if (!connection) {
    connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false,
    });

    player = createAudioPlayer();

    player.on(AudioPlayerStatus.Idle, () => {
      stopYtDlp(guildId);
      currentResources.delete(guildId);
      nowPlaying.delete(guildId);
      void playNextSong(guildId);
    });

    player.on("error", (error) => {
      console.error(`Music player error in ${guildId}:`, error);
      stopYtDlp(guildId);
      currentResources.delete(guildId);
      void playNextSong(guildId);
    });

    connection.subscribe(player);
    voiceConnections.set(guildId, connection);
    audioPlayers.set(guildId, player);

    if (!musicVolumes.has(guildId)) {
      musicVolumes.set(guildId, 0.75);
    }

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
    } catch (error) {
      try {
        connection.destroy();
      } catch {}

      voiceConnections.delete(guildId);
      audioPlayers.delete(guildId);
      throw error;
    }
  }

  return { connection, player };
};

const playNextSong = async (guildId: string) => {
  const queue = musicQueue.get(guildId) || [];
  const player = audioPlayers.get(guildId);

  if (!player) {
    cleanupMusic(guildId);
    return;
  }

  if (queue.length === 0) {
    cleanupMusic(guildId);
    return;
  }

  const songQuery = queue.shift()!;
  musicQueue.set(guildId, queue);

  const track = await resolveSong(songQuery);

  if (!track) {
    await sendMusicMessage(
      guildId,
      `❌ I couldn't find **${songQuery}**. Skipping it.`
    );

    void playNextSong(guildId);
    return;
  }

  stopYtDlp(guildId);
  nowPlaying.set(guildId, track.title);

  try {
    if (!ytdlp) throw new Error("Music engine is not initialized yet.");

    // ytdlp-nodejs manages the yt-dlp binary for us.
    // Direct WebM/Opus output lets Discord Voice consume the stream directly.
    const process = ytdlp.exec(track.url, {
      noWarnings: true,
      noPlaylist: true,
      format: "bestaudio[ext=webm][acodec=opus]/bestaudio[acodec=opus]",
      output: "-",
    });

    ytDlpProcesses.set(guildId, process);

    let stderrText = "";

    process.stderr.on("data", (chunk: Buffer) => {
      const message = chunk.toString().trim();

      if (message) {
        stderrText += `${message}\n`;
        console.log(`[yt-dlp:${guildId}] ${message}`);
      }
    });

    process.on("error", (error) => {
      console.error(`yt-dlp process error for ${guildId}:`, error);
    });

    process.on("close", (code) => {
      if (code !== 0 && stderrText) {
        console.error(
          `[yt-dlp:${guildId}] exited with code ${code}: ${stderrText.trim()}`
        );
      }

      if (ytDlpProcesses.get(guildId) === process) {
        ytDlpProcesses.delete(guildId);
      }
    });

    const resource = createAudioResource(process.stdout, {
      inputType: StreamType.WebmOpus,
      inlineVolume: true,
    });

    resource.volume?.setVolume(musicVolumes.get(guildId) ?? 0.75);
    currentResources.set(guildId, resource);

    player.play(resource);

    await sendMusicMessage(guildId, `▶️ Now playing **${track.title}**`);
  } catch (error) {
    console.error(`Error playing ${track.title}:`, error);
    stopYtDlp(guildId);
    currentResources.delete(guildId);
    void playNextSong(guildId);
  }
};

// discord.js v15 uses clientReady for the client-ready event.
client.once("clientReady", async () => {
  console.log(`✓ Bot logged in as ${client.user?.tag}`);

  try {
    console.log("⏬ Preparing yt-dlp binary for music...");
    const binaryPath = await helpers.downloadYtDlp();
    ytdlp = new YtDlp({ binaryPath });
    console.log(`✓ yt-dlp ready at ${binaryPath}`);
  } catch (error) {
    console.error("❌ Failed to prepare yt-dlp:", error);
    console.error("Music commands will be unavailable until yt-dlp is available.");
  }

  try {
    await rest.put(Routes.applicationCommands(client.user!.id), {
      body: commands.map((cmd) => cmd.toJSON()),
    });
    console.log("✓ Slash commands registered");
  } catch (error) {
    console.error("Failed to register commands:", error);
  }

  // Update status on startup and every 5 minutes.
  updateBotStatus();
  setInterval(updateBotStatus, 300000);
});

// Update status when member joins/leaves
client.on("guildMemberAdd", () => {
  updateBotStatus();
});

client.on("guildMemberRemove", () => {
  updateBotStatus();
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const userId = interaction.user.id;
  const guildId = interaction.guildId || "default";
  
  if (!wallets.has(userId)) wallets.set(userId, BASE_BALANCE);

  const balance = wallets.get(userId)!;

  try {
    // Check if user is blacklisted for gambling commands
    const gamblingCommands = ["bet", "roll", "balance", "leaderboard"];
    if (gamblingCommands.includes(interaction.commandName) && blacklist.has(userId)) {
      const embed = new EmbedBuilder()
        .setColor(0xff0000)
        .setTitle("❌ Access Denied")
        .setDescription("You are blacklisted and cannot use gambling commands.");
      await interaction.reply({ embeds: [embed], ephemeral: true });
      return;
    }

    switch (interaction.commandName) {
      case "balance": {
        const embed = new EmbedBuilder()
          .setColor(0x00ff00)
          .setTitle("💰 Your Balance")
          .setDescription(`You have **${balance}** credits`)
          .setFooter({ text: interaction.user.tag });
        await interaction.reply({ embeds: [embed] });
        break;
      }

      case "bet": {
        const amount = interaction.options.getInteger("amount")!;

        if (amount <= 0) {
          await interaction.reply({
            content: "❌ Bet must be greater than 0",
            ephemeral: true,
          });
          break;
        }
        if (amount > balance) {
          await interaction.reply({
            content: `❌ Insufficient balance. You have ${balance} credits.`,
            ephemeral: true,
          });
          break;
        }

        const won = Math.random() < 0.5;
        const newBalance = won ? balance + amount : balance - amount;
        wallets.set(userId, newBalance);

        const result = won ? "🎉 **You won!**" : "💔 **You lost!**";
        const embed = new EmbedBuilder()
          .setColor(won ? 0x00ff00 : 0xff0000)
          .setTitle("Coin Flip")
          .setDescription(result)
          .addFields(
            { name: "Bet Amount", value: `${amount}`, inline: true },
            { name: "Payout", value: `${won ? amount : -amount}`, inline: true },
            { name: "New Balance", value: `${newBalance}`, inline: true }
          )
          .setFooter({ text: interaction.user.tag });

        await interaction.reply({ embeds: [embed] });
        break;
      }

      case "roll": {
        const amount = interaction.options.getInteger("amount")!;

        if (amount <= 0) {
          await interaction.reply({
            content: "❌ Bet must be greater than 0",
            ephemeral: true,
          });
          break;
        }
        if (amount > balance) {
          await interaction.reply({
            content: `❌ Insufficient balance. You have ${balance} credits.`,
            ephemeral: true,
          });
          break;
        }

        const roll = Math.floor(Math.random() * 20) + 1;
        let multiplier = 0;
        if (roll >= 18) multiplier = 3;
        else if (roll >= 15) multiplier = 2;
        else if (roll >= 10) multiplier = 1;

        const payout = Math.floor(amount * multiplier);
        const newBalance = balance - amount + payout;
        wallets.set(userId, newBalance);

        const embed = new EmbedBuilder()
          .setColor(multiplier > 0 ? 0x00ff00 : 0xff0000)
          .setTitle("🎲 D20 Roll")
          .setDescription(
            multiplier > 0
              ? `🎉 Rolled **${roll}**! **${multiplier}x multiplier!**`
              : `Rolled **${roll}**. No win.`
          )
          .addFields(
            { name: "Bet", value: `${amount}`, inline: true },
            { name: "Payout", value: `${payout}`, inline: true },
            { name: "New Balance", value: `${newBalance}`, inline: true }
          )
          .setFooter({ text: interaction.user.tag });

        await interaction.reply({ embeds: [embed] });
        break;
      }

      case "verify": {
        const code = Math.random().toString(36).substring(2, 8).toUpperCase();
        const embed = new EmbedBuilder()
          .setColor(0x0099ff)
          .setTitle("🔐 Security Verification")
          .setDescription(
            `Your verification code is: \`${code}\`\n\nKeep this private. Never share with others.`
          )
          .setFooter({ text: "Code expires in 5 minutes" });

        await interaction.reply({ embeds: [embed], ephemeral: true });
        break;
      }

      case "leaderboard": {
        const sorted = Array.from(wallets.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10);

        const description =
          sorted.length > 0
            ? sorted
                .map(
                  ([uid, bal], idx) =>
                    `${idx + 1}. <@${uid}> - **${bal}** credits`
                )
                .join("\n")
            : "No players yet.";

        const embed = new EmbedBuilder()
          .setColor(0xffd700)
          .setTitle("🏆 Leaderboard")
          .setDescription(description)
          .setFooter({ text: "Top 10 players" });

        await interaction.reply({ embeds: [embed] });
        break;
      }

      case "setcurrency": {
        // Admin check
        if (interaction.user.username !== ADMIN_USERNAME) {
          await interaction.reply({
            content: `❌ Only **${ADMIN_USERNAME}** can use this command.`,
            ephemeral: true,
          });
          break;
        }

        const targetId = interaction.options.getString("user_id")!;
        const amount = interaction.options.getInteger("amount")!;

        if (amount < 0) {
          await interaction.reply({
            content: "❌ Currency amount cannot be negative.",
            ephemeral: true,
          });
          break;
        }

        const oldBalance = wallets.get(targetId) || 0;
        wallets.set(targetId, amount);

        const embed = new EmbedBuilder()
          .setColor(0x0099ff)
          .setTitle("⚙️ Currency Updated")
          .setDescription(`Currency set for <@${targetId}>`)
          .addFields(
            { name: "Previous Balance", value: `${oldBalance}`, inline: true },
            { name: "New Balance", value: `${amount}`, inline: true }
          );

        await interaction.reply({ embeds: [embed] });
        console.log(`Admin ${interaction.user.username} set currency for ${targetId} to ${amount}`);
        break;
      }

      case "removeallroles": {
        // Admin check
        if (interaction.user.username !== ADMIN_USERNAME) {
          await interaction.reply({
            content: `❌ Only **${ADMIN_USERNAME}** can use this command.`,
            ephemeral: true,
          });
          break;
        }

        const targetId = interaction.options.getString("user_id")!;

        try {
          const guild = interaction.guild;
          if (!guild) {
            await interaction.reply({
              content: "❌ Could not access server information.",
              ephemeral: true,
            });
            break;
          }

          const member = await guild.members.fetch(targetId);
          if (!member) {
            await interaction.reply({
              content: `❌ User <@${targetId}> is not in this server.`,
              ephemeral: true,
            });
            break;
          }

          // Get all roles except @everyone
          const rolesToRemove = member.roles.cache.filter(role => role.id !== guild.id);

          if (rolesToRemove.size === 0) {
            await interaction.reply({
              content: `ℹ️ User <@${targetId}> has no roles to remove.`,
              ephemeral: true,
            });
            break;
          }

          // Remove all roles
          await member.roles.remove(rolesToRemove);

          const embed = new EmbedBuilder()
            .setColor(0x0099ff)
            .setTitle("🗑️ Roles Removed")
            .setDescription(`All roles have been removed from <@${targetId}>`)
            .addFields({ name: "Roles Removed", value: `${rolesToRemove.size}`, inline: true });

          await interaction.reply({ embeds: [embed] });
          console.log(`Admin ${interaction.user.username} removed all roles from ${targetId}`);
        } catch (error) {
          console.error("Remove roles error:", error);
          await interaction.reply({
            content: `❌ Failed to remove roles. Make sure the bot has manage roles permission.`,
            ephemeral: true,
          });
        }
        break;
      }

      case "purge": {
        // Admin check
        if (interaction.user.username !== ADMIN_USERNAME) {
          await interaction.reply({
            content: `❌ Only **${ADMIN_USERNAME}** can use this command.`,
            ephemeral: true,
          });
          break;
        }

        const amount = interaction.options.getInteger("amount")!;

        if (amount < 1 || amount > 100) {
          await interaction.reply({
            content: "❌ You must purge between 1 and 100 messages.",
            ephemeral: true,
          });
          break;
        }

        try {
          const channel = interaction.channel;
          if (!channel || channel.type !== ChannelType.GuildText) {
            await interaction.reply({
              content: "❌ This command only works in text channels.",
              ephemeral: true,
            });
            break;
          }

          // Fetch and delete messages
          const messages = await channel.messages.fetch({ limit: amount });
          const deleted = await channel.bulkDelete(messages);

          const embed = new EmbedBuilder()
            .setColor(0xff0000)
            .setTitle("🗑️ Messages Purged")
            .setDescription(`Deleted ${deleted.size} messages from ${channel.name}`)
            .addFields({ name: "Channel", value: `<#${channel.id}>`, inline: true });

          await interaction.reply({ embeds: [embed] });
          console.log(`Admin ${interaction.user.username} purged ${deleted.size} messages from ${channel.name}`);
        } catch (error) {
          console.error("Purge error:", error);
          await interaction.reply({
            content: `❌ Failed to purge messages. Make sure the bot has manage messages permission.`,
            ephemeral: true,
          });
        }
        break;
      }
      case "play": {
        const voiceChannel = interaction.member?.voice?.channel;

        if (!voiceChannel || !voiceChannel.isVoiceBased()) {
          await interaction.reply({
            content: "❌ Join a voice channel first.",
            ephemeral: true,
          });
          break;
        }

        const song = interaction.options.getString("song", true).trim();

        // Acknowledge immediately so Discord does not expire the interaction
        // while the bot connects to voice or searches YouTube.
        await interaction.deferReply();

        try {
          const wasPlaying = Boolean(nowPlaying.get(guildId));
          const queue = musicQueue.get(guildId) || [];

          await ensureVoice(guildId, voiceChannel as VoiceBasedChannel);

          queue.push(song);
          musicQueue.set(guildId, queue);

          await interaction.editReply(
            wasPlaying
              ? `➕ Added **${song}** to the queue.`
              : `🔎 Searching for **${song}**...`
          );

          const player = audioPlayers.get(guildId);

          if (
            player &&
            player.state.status === AudioPlayerStatus.Idle &&
            !nowPlaying.has(guildId)
          ) {
            void playNextSong(guildId);
          }
        } catch (error) {
          console.error("Play command error:", error);

          const queue = musicQueue.get(guildId) || [];
          if (queue[queue.length - 1] === song) {
            queue.pop();
            musicQueue.set(guildId, queue);
          }

          await interaction.editReply(
            ytdlp
              ? "❌ I couldn't start the music system."
              : "❌ The music engine is not ready yet. Check the Railway logs for the yt-dlp setup error."
          ).catch(() => {});
        }

        break;
      }

      case "queue": {
        const queue = musicQueue.get(guildId) || [];
        const current = nowPlaying.get(guildId);
        const lines: string[] = [];

        if (current) {
          lines.push(`🎵 **Now playing:** ${current}`);
        }

        if (queue.length > 0) {
          lines.push(
            `\n**Up next:**\n${queue
              .slice(0, 10)
              .map((song, i) => `${i + 1}. ${song}`)
              .join("\n")}`
          );

          if (queue.length > 10) {
            lines.push(`\n…and ${queue.length - 10} more.`);
          }
        } else if (!current) {
          lines.push("🎶 The music queue is empty.");
        } else {
          lines.push("\n🎶 Nothing else is queued.");
        }

        await interaction.reply(lines.join("\n"));
        break;
      }

      case "skip": {
        const player = audioPlayers.get(guildId);

        if (!player || !nowPlaying.has(guildId)) {
          await interaction.reply({
            content: "❌ Nothing is currently playing.",
            ephemeral: true,
          });
          break;
        }

        await interaction.reply("⏭️ Skipping...");
        stopYtDlp(guildId);
        player.stop(true);
        break;
      }

      case "stop": {
        musicQueue.set(guildId, []);

        stopYtDlp(guildId);
        currentResources.delete(guildId);

        const player = audioPlayers.get(guildId);
        try {
          player?.stop(true);
        } catch {}

        const connection = voiceConnections.get(guildId);
        try {
          connection?.destroy?.();
        } catch {}

        voiceConnections.delete(guildId);
        audioPlayers.delete(guildId);
        nowPlaying.delete(guildId);

        await interaction.reply(
          "⏹️ Stopped the music, cleared the queue, and left the voice channel."
        );
        break;
      }

      case "pause": {
        const player = audioPlayers.get(guildId);

        if (!player || !nowPlaying.has(guildId)) {
          await interaction.reply({
            content: "❌ Nothing is currently playing.",
            ephemeral: true,
          });
          break;
        }

        player.pause();
        await interaction.reply("⏸️ Paused.");
        break;
      }

      case "resume": {
        const player = audioPlayers.get(guildId);

        if (!player || !nowPlaying.has(guildId)) {
          await interaction.reply({
            content: "❌ Nothing is currently playing.",
            ephemeral: true,
          });
          break;
        }

        player.unpause();
        await interaction.reply("▶️ Resumed.");
        break;
      }

      case "nowplaying": {
        const current = nowPlaying.get(guildId);

        if (!current) {
          await interaction.reply({
            content: "❌ Nothing is currently playing.",
            ephemeral: true,
          });
          break;
        }

        await interaction.reply(`🎵 **Now playing:** ${current}`);
        break;
      }

      case "volume": {
        const amount = interaction.options.getInteger("amount", true);
        const resource = currentResources.get(guildId);

        if (!resource?.volume) {
          await interaction.reply({
            content: "❌ Nothing is currently playing.",
            ephemeral: true,
          });
          break;
        }

        const volume = amount / 100;
        musicVolumes.set(guildId, volume);
        resource.volume.setVolume(volume);

        await interaction.reply(`🔊 Volume set to **${amount}%**.`);
        break;
      }

     case "blacklist": {
        const subcommand = interaction.options.getSubcommand();
        const targetId = interaction.options.getString("user_id");

        switch (subcommand) {
          case "add": {
            if (blacklist.has(targetId)) {
              await interaction.reply({
                content: `❌ User <@${targetId}> is already blacklisted and banned.`,
                ephemeral: true,
              });
              break;
            }

            try {
              const guild = interaction.guild;
              if (!guild) {
                await interaction.reply({
                  content: "❌ Could not access server information.",
                  ephemeral: true,
                });
                break;
              }

              const reason = interaction.options.getString("reason") || "Blacklisted by admin";

              // Ban the user from the server
              await guild.bans.create(targetId, { reason });

              // Add to blacklist
              blacklist.add(targetId);

              const embed = new EmbedBuilder()
                .setColor(0xff0000)
                .setTitle("🚫 User Blacklisted & Banned")
                .setDescription(`<@${targetId}> has been added to the blacklist and banned from the server.`)
                .addFields(
                  { name: "User ID", value: targetId, inline: true },
                  { name: "Reason", value: reason, inline: true }
                );

              await interaction.reply({ embeds: [embed] });
              console.log(`User ${targetId} blacklisted and banned. Reason: ${reason}`);
            } catch (error) {
              console.error("Ban error:", error);
              await interaction.reply({
                content: `❌ Failed to ban user. Make sure the bot has ban permissions.`,
                ephemeral: true,
              });
            }
            break;
          }

          case "remove": {
            if (!blacklist.has(targetId)) {
              await interaction.reply({
                content: `❌ User <@${targetId}> is not on the blacklist.`,
                ephemeral: true,
              });
              break;
            }

            try {
              const guild = interaction.guild;
              if (!guild) {
                await interaction.reply({
                  content: "❌ Could not access server information.",
                  ephemeral: true,
                });
                break;
              }

              // Unban the user from the server
              await guild.bans.remove(targetId, "Unblacklisted by admin");

              // Remove from blacklist
              blacklist.delete(targetId);

              const embed = new EmbedBuilder()
                .setColor(0x00ff00)
                .setTitle("✅ User Unblacklisted & Unbanned")
                .setDescription(`<@${targetId}> has been removed from the blacklist and unbanned from the server.`)
                .addFields({ name: "Status", value: "Can now access the server and use gambling commands" });

              await interaction.reply({ embeds: [embed] });
              console.log(`User ${targetId} unblacklisted and unbanned`);
            } catch (error) {
              console.error("Unban error:", error);
              await interaction.reply({
                content: `❌ Failed to unban user. Make sure the user is actually banned.`,
                ephemeral: true,
              });
            }
            break;
          }

          case "list": {
            const list =
              blacklist.size > 0
                ? Array.from(blacklist)
                    .map((id, idx) => `${idx + 1}. \`${id}\``)
                    .join("\n")
                : "No users blacklisted.";

            const embed = new EmbedBuilder()
              .setColor(0xffa500)
              .setTitle("🚫 Blacklist")
              .setDescription(list)
              .setFooter({ text: `Total blacklisted: ${blacklist.size}` });

            await interaction.reply({ embeds: [embed] });
            break;
          }
        }
        break;
      }
    }
  } catch (error) {
    console.error("Command error:", error);

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({
        content: "❌ An error occurred",
        ephemeral: true,
      }).catch(() => {});
    } else {
      await interaction.reply({
        content: "❌ An error occurred",
        ephemeral: true,
      }).catch(() => {});
    }
  }
});

client.login(process.env.DISCORD_TOKEN);

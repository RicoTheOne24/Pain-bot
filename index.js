import { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, EmbedBuilder, ChannelType, ActivityType, VoiceBasedChannel } from "discord.js";
import { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, StreamType, entersState } from "@discordjs/voice";
import type { ChildProcessWithoutNullStreams } from "child_process";
import { YtDlp, helpers } from "ytdlp-nodejs";

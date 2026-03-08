require('dotenv').config();
const {
  Client, GatewayIntentBits, Collection,
  REST, Routes, SlashCommandBuilder, EmbedBuilder
} = require('discord.js');
const {
  joinVoiceChannel, createAudioPlayer, createAudioResource,
  AudioPlayerStatus, VoiceConnectionStatus, entersState
} = require('@discordjs/voice');
const playdl = require('play-dl');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.queues = new Map();

function getQ(gid) { return client.queues.get(gid) || null; }

function makeQ(gid) {
  const q = {
    guildId: gid, songs: [], currentSong: null,
    volume: 80, loop: 'off', shuffle: false,
    connection: null, player: null, resource: null, textChannel: null,
  };
  client.queues.set(gid, q);
  return q;
}

function destroyQ(gid) {
  const q = client.queues.get(gid);
  if (!q) return;
  try { q.player && q.player.stop(true); } catch {}
  try { q.connection && q.connection.destroy(); } catch {}
  client.queues.delete(gid);
}

async function playSong(q) {
  if (!q.songs.length && q.loop !== 'song') {
    const e = new EmbedBuilder().setColor('#FF6B6B').setDescription('Queue finished! Thanks for using PattuPetti!');
    if (q.textChannel) q.textChannel.send({ embeds: [e] });
    destroyQ(q.guildId); return;
  }
  if (q.loop !== 'song') {
    if (q.shuffle && q.songs.length > 1) {
      const i = Math.floor(Math.random() * q.songs.length);
      q.songs.unshift(q.songs.splice(i, 1)[0]);
    }
    q.currentSong = q.songs.shift();
    if (q.loop === 'queue') q.songs.push(Object.assign({}, q.currentSong));
  }
  try {
    const stream = await playdl.stream(q.currentSong.url, { quality: 2 });
    const resource = createAudioResource(stream.stream, { inputType: stream.type, inlineVolume: true });
    resource.volume.setVolumeLogarithmic(q.volume / 100);
    q.resource = resource;
    q.player.play(resource);
    const loopIcon = q.loop === 'song' ? 'Song' : q.loop === 'queue' ? 'Queue' : 'Off';
    const e = new EmbedBuilder()
      .setColor('#FF6B6B').setAuthor({ name: 'Now Playing - PattuPetti' })
      .setTitle(q.currentSong.title).setURL(q.currentSong.url)
      .setThumbnail(q.currentSong.thumbnail || null)
      .addFields(
        { name: 'Duration', value: q.currentSong.duration || 'Live', inline: true },
        { name: 'Volume', value: q.volume + '%', inline: true },
        { name: 'Loop', value: loopIcon, inline: true },
        { name: 'Requested by', value: q.currentSong.requestedBy, inline: true },
        { name: 'In Queue', value: q.songs.length + ' song(s)', inline: true },
        { name: 'Shuffle', value: q.shuffle ? 'On' : 'Off', inline: true }
      ).setFooter({ text: 'PattuPetti - Free Music for Everyone' });
    if (q.textChannel) q.textChannel.send({ embeds: [e] });
  } catch (err) {
    console.error('Stream error:', err.message);
    if (q.textChannel) q.textChannel.send({ content: 'Could not play ' + (q.currentSong ? q.currentSong.title : 'song') + ' - skipping...' });
    if (q.songs.length) playSong(q); else destroyQ(q.guildId);
  }
}

const commands = [
  {
    data: new SlashCommandBuilder().setName('play').setDescription('Play a song from YouTube').addStringOption(o => o.setName('query').setDescription('Song name or YouTube URL').setRequired(true)),
    async run(i) {
      await i.deferReply();
      const vc = i.member.voice.channel;
      if (!vc) return i.editReply('Join a voice channel first!');
      const query = i.options.getString('query');
      let song;
      try {
        const isURL = playdl.yt_validate(query) === 'video';
        if (isURL) {
          const info = await playdl.video_info(query);
          const d = info.video_details;
          song = { title: d.title, url: d.url, duration: d.durationRaw, thumbnail: d.thumbnails[0] ? d.thumbnails[0].url : null, requestedBy: i.user.tag };
        } else {
          const res = await playdl.search(query, { limit: 1 });
          if (!res.length) return i.editReply('No results found!');
          song = { title: res[0].title, url: res[0].url, duration: res[0].durationRaw, thumbnail: res[0].thumbnails[0] ? res[0].thumbnails[0].url : null, requestedBy: i.user.tag };
        }
      } catch (e) { return i.editReply('Could not fetch the song. Try again!'); }
      let q = getQ(i.guild.id);
      const isNew = !q;
      if (isNew) q = makeQ(i.guild.id);
      q.textChannel = i.channel;
      q.songs.push(song);
      if (isNew) {
        const conn = joinVoiceChannel({ channelId: vc.id, guildId: i.guild.id, adapterCreator: i.guild.voiceAdapterCreator });
        q.connection = conn;
        const player = createAudioPlayer();
        q.player = player;
        conn.subscribe(player);
        conn.on(VoiceConnectionStatus.Disconnected, async () => {
          try { await Promise.race([entersState(conn, VoiceConnectionStatus.Signalling, 5000), entersState(conn, VoiceConnectionStatus.Connecting, 5000)]); }
          catch { destroyQ(i.guild.id); }
        });
        player.on(AudioPlayerStatus.Idle, () => {
          const qq = getQ(i.guild.id);
          if (!qq) return;
          if (qq.loop === 'song') { playSong(qq); return; }
          if (qq.songs.length) { playSong(qq); }
          else { if (qq.textChannel) qq.textChannel.send({ embeds: [new EmbedBuilder().setColor('#FF6B6B').setDescription('Queue finished!')] }); destroyQ(qq.guildId); }
        });
        player.on('error', err => { console.error(err); const qq = getQ(i.guild.id); if (qq && qq.songs.length) playSong(qq); });
        playSong(q);
        return i.editReply({ embeds: [new EmbedBuilder().setColor('#00FF7F').setDescription('Joined ' + vc.name + '! Playing: **' + song.title + '**')] });
      }
      return i.editReply({ embeds: [new EmbedBuilder().setColor('#4ECDC4').setTitle('Added to Queue').setDescription('**' + song.title + '**').addFields({ name: 'Position', value: '#' + q.songs.length, inline: true }, { name: 'Duration', value: song.duration || 'N/A', inline: true })] });
    }
  },
  { data: new SlashCommandBuilder().setName('pause').setDescription('Pause the current song'),
    async run(i) { const q = getQ(i.guild.id); if (!q) return i.reply('Nothing playing!'); if (q.player.state.status === AudioPlayerStatus.Playing) { q.player.pause(); return i.reply({ embeds: [new EmbedBuilder().setColor('#FFA500').setDescription('Paused! Use /resume to continue.')] }); } return i.reply('Already paused!'); } },
  { data: new SlashCommandBuilder().setName('resume').setDescription('Resume the paused song'),
    async run(i) { const q = getQ(i.guild.id); if (!q) return i.reply('Nothing in queue!'); if (q.player.state.status === AudioPlayerStatus.Paused) { q.player.unpause(); return i.reply({ embeds: [new EmbedBuilder().setColor('#00FF7F').setDescription('Resumed!')] }); } return i.reply('Not paused!'); } },
  { data: new SlashCommandBuilder().setName('skip').setDescription('Skip the current song').addIntegerOption(o => o.setName('count').setDescription('Songs to skip').setMinValue(1)),
    async run(i) { const q = getQ(i.guild.id); if (!q) return i.reply('Nothing playing!'); const count = (i.options.getInteger('count') || 1) - 1; if (count > 0) q.songs.splice(0, Math.min(count, q.songs.length)); const skipped = q.currentSong ? q.currentSong.title : 'Unknown'; const prevLoop = q.loop; q.loop = 'off'; q.player.stop(); q.loop = prevLoop; return i.reply({ embeds: [new EmbedBuilder().setColor('#87CEEB').setDescription('Skipped: **' + skipped + '**')] }); } },
  { data: new SlashCommandBuilder().setName('stop').setDescription('Stop music and clear the queue'),
    async run(i) { if (!getQ(i.guild.id)) return i.reply('Nothing playing!'); destroyQ(i.guild.id); return i.reply({ embeds: [new EmbedBuilder().setColor('#FF4444').setDescription('Stopped and cleared queue!')] }); } },
  { data: new SlashCommandBuilder().setName('volume').setDescription('Set or check the volume').addIntegerOption(o => o.setName('level').setDescription('Volume 1-200').setMinValue(1).setMaxValue(200)),
    async run(i) { const q = getQ(i.guild.id); if (!q) return i.reply('Nothing playing!'); const level = i.options.getInteger('level'); if (!level) return i.reply({ embeds: [new EmbedBuilder().setColor('#FFD700').setDescription('Current volume: **' + q.volume + '%**')] }); q.volume = level; if (q.resource && q.resource.volume) q.resource.volume.setVolumeLogarithmic(level / 100); return i.reply({ embeds: [new EmbedBuilder().setColor('#FFD700').setDescription('Volume set to **' + level + '%**')] }); } },
  { data: new SlashCommandBuilder().setName('volumeup').setDescription('Increase volume by 10%'),
    async run(i) { const q = getQ(i.guild.id); if (!q) return i.reply('Nothing playing!'); q.volume = Math.min(200, q.volume + 10); if (q.resource && q.resource.volume) q.resource.volume.setVolumeLogarithmic(q.volume / 100); return i.reply({ embeds: [new EmbedBuilder().setColor('#FFD700').setDescription('Volume increased to **' + q.volume + '%**')] }); } },
  { data: new SlashCommandBuilder().setName('volumedown').setDescription('Decrease volume by 10%'),
    async run(i) { const q = getQ(i.guild.id); if (!q) return i.reply('Nothing playing!'); q.volume = Math.max(1, q.volume - 10); if (q.resource && q.resource.volume) q.resource.volume.setVolumeLogarithmic(q.volume / 100); return i.reply({ embeds: [new EmbedBuilder().setColor('#FFD700').setDescription('Volume decreased to **' + q.volume + '%**')] }); } },
  { data: new SlashCommandBuilder().setName('queue').setDescription('Show the current queue').addIntegerOption(o => o.setName('page').setDescription('Page number').setMinValue(1)),
    async run(i) { const q = getQ(i.guild.id); if (!q || (!q.currentSong && !q.songs.length)) return i.reply('Queue is empty!'); const page = i.options.getInteger('page') || 1; const pageSize = 10; const start = (page - 1) * pageSize; const items = q.songs.slice(start, start + pageSize); let desc = q.currentSong ? '**Now Playing:** ' + q.currentSong.title + '\n\n' : ''; if (items.length) { desc += items.map((s, idx) => (start + idx + 1) + '. ' + s.title + ' [' + (s.duration || 'N/A') + ']').join('\n'); } else { desc += 'No more songs in queue.'; } const totalPages = Math.ceil(q.songs.length / pageSize) || 1; return i.reply({ embeds: [new EmbedBuilder().setColor('#9B59B6').setTitle('Queue - PattuPetti').setDescription(desc).setFooter({ text: 'Page ' + page + '/' + totalPages + ' | Total: ' + q.songs.length + ' songs' })] }); } },
  { data: new SlashCommandBuilder().setName('nowplaying').setDescription('Show the currently playing song'),
    async run(i) { const q = getQ(i.guild.id); if (!q || !q.currentSong) return i.reply('Nothing is playing!'); const s = q.currentSong; return i.reply({ embeds: [new EmbedBuilder().setColor('#FF6B6B').setTitle('Now Playing').setDescription('**[' + s.title + '](' + s.url + ')**').addFields({ name: 'Duration', value: s.duration || 'Live', inline: true }, { name: 'Volume', value: q.volume + '%', inline: true }, { name: 'Loop', value: q.loop, inline: true }, { name: 'Requested by', value: s.requestedBy, inline: true }).setThumbnail(s.thumbnail || null).setFooter({ text: 'PattuPetti' })] }); } },
  { data: new SlashCommandBuilder().setName('loop').setDescription('Set loop mode').addStringOption(o => o.setName('mode').setDescription('Loop mode').setRequired(true).addChoices({ name: 'Off', value: 'off' }, { name: 'Song', value: 'song' }, { name: 'Queue', value: 'queue' })),
    async run(i) { const q = getQ(i.guild.id); if (!q) return i.reply('Nothing playing!'); q.loop = i.options.getString('mode'); const icons = { off: 'Off', song: 'Song (repeating current)', queue: 'Queue (repeating all)' }; return i.reply({ embeds: [new EmbedBuilder().setColor('#E74C3C').setDescription('Loop set to: **' + icons[q.loop] + '**')] }); } },
  { data: new SlashCommandBuilder().setName('shuffle').setDescription('Toggle shuffle mode'),
    async run(i) { const q = getQ(i.guild.id); if (!q) return i.reply('Nothing playing!'); q.shuffle = !q.shuffle; return i.reply({ embeds: [new EmbedBuilder().setColor('#F39C12').setDescription('Shuffle: **' + (q.shuffle ? 'ON' : 'OFF') + '**')] }); } },
  { data: new SlashCommandBuilder().setName('remove').setDescription('Remove a song from queue').addIntegerOption(o => o.setName('position').setDescription('Position in queue').setRequired(true).setMinValue(1)),
    async run(i) { const q = getQ(i.guild.id); if (!q || !q.songs.length) return i.reply('Queue is empty!'); const pos = i.options.getInteger('position') - 1; if (pos >= q.songs.length) return i.reply('Invalid position!'); const removed = q.songs.splice(pos, 1)[0]; return i.reply({ embeds: [new EmbedBuilder().setColor('#E74C3C').setDescription('Removed: **' + removed.title + '**')] }); } },
  { data: new SlashCommandBuilder().setName('clear').setDescription('Clear the queue (keep current song playing)'),
    async run(i) { const q = getQ(i.guild.id); if (!q) return i.reply('Nothing playing!'); q.songs = []; return i.reply({ embeds: [new EmbedBuilder().setColor('#E74C3C').setDescription('Queue cleared!')] }); } },
  { data: new SlashCommandBuilder().setName('join').setDescription('Join your voice channel'),
    async run(i) { const vc = i.member.voice.channel; if (!vc) return i.reply('Join a voice channel first!'); let q = getQ(i.guild.id); if (!q) q = makeQ(i.guild.id); q.textChannel = i.channel; if (!q.connection || q.connection.state.status === 'destroyed') { const conn = joinVoiceChannel({ channelId: vc.id, guildId: i.guild.id, adapterCreator: i.guild.voiceAdapterCreator }); q.connection = conn; const player = createAudioPlayer(); q.player = player; conn.subscribe(player); player.on(AudioPlayerStatus.Idle, () => { const qq = getQ(i.guild.id); if (!qq) return; if (qq.loop === 'song') { playSong(qq); return; } if (qq.songs.length) playSong(qq); else { if (qq.textChannel) qq.textChannel.send('Queue finished!'); destroyQ(qq.guildId); } }); } return i.reply({ embeds: [new EmbedBuilder().setColor('#00FF7F').setDescription('Joined **' + vc.name + '**!')] }); } },
  { data: new SlashCommandBuilder().setName('leave').setDescription('Leave the voice channel'),
    async run(i) { if (!getQ(i.guild.id)) return i.reply('Not in a voice channel!'); destroyQ(i.guild.id); return i.reply({ embeds: [new EmbedBuilder().setColor('#FF6B6B').setDescription('Left the voice channel. Goodbye!')] }); } },
  { data: new SlashCommandBuilder().setName('search').setDescription('Search for a song and pick from results').addStringOption(o => o.setName('query').setDescription('Search query').setRequired(true)),
    async run(i) { await i.deferReply(); const query = i.options.getString('query'); try { const res = await playdl.search(query, { limit: 5 }); if (!res.length) return i.editReply('No results found!'); let desc = res.map((s, idx) => (idx + 1) + '. **' + s.title + '** [' + (s.durationRaw || 'N/A') + ']\n   ' + s.url).join('\n\n'); desc += '\n\nUse `/play` with the URL or song name to play!'; return i.editReply({ embeds: [new EmbedBuilder().setColor('#3498DB').setTitle('Search Results').setDescription(desc).setFooter({ text: 'PattuPetti Search' })] }); } catch { return i.editReply('Search failed. Try again!'); } } },
];

// ── Register slash commands on ready ──────────────────────────────────────────
client.once('ready', async () => {
  console.log('PattuPetti is online as ' + client.user.tag);
  client.user.setActivity('!play or /play | PattuPetti', { type: 2 });
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands.map(c => c.data.toJSON()) });
    console.log('Slash commands registered globally.');
  } catch (err) { console.error('Error registering commands:', err); }
});

// ── Slash command handler ─────────────────────────────────────────────────────
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const cmd = commands.find(c => c.data.name === interaction.commandName);
  if (!cmd) return;
  try { await cmd.run(interaction); }
  catch (err) {
    console.error(err);
    const msg = { content: 'An error occurred!', ephemeral: true };
    if (interaction.replied || interaction.deferred) interaction.followUp(msg);
    else interaction.reply(msg);
  }
});

// ── PREFIX command handler (!play, !stop, etc.) ───────────────────────────────
client.on('messageCreate', async message => {
  if (message.author.bot) return;
  const prefix = '!';
  if (!message.content.startsWith(prefix)) return;
  const args = message.content.slice(prefix.length).trim().split(/ +/);
  const cmd = args.shift().toLowerCase();

  if (cmd === 'play') {
    const query = args.join(' ');
    if (!query) return message.reply('Please provide a song name or URL! Usage: `!play <song/URL>`');
    const vc = message.member.voice.channel;
    if (!vc) return message.reply('Join a voice channel first!');
    let song;
    try {
      const isURL = playdl.yt_validate(query) === 'video';
      if (isURL) {
        const info = await playdl.video_info(query);
        const d = info.video_details;
        song = { title: d.title, url: d.url, duration: d.durationRaw, thumbnail: d.thumbnails[0] ? d.thumbnails[0].url : null, requestedBy: message.author.tag };
      } else {
        const res = await playdl.search(query, { limit: 1 });
        if (!res.length) return message.reply('No results found!');
        song = { title: res[0].title, url: res[0].url, duration: res[0].durationRaw, thumbnail: res[0].thumbnails[0] ? res[0].thumbnails[0].url : null, requestedBy: message.author.tag };
      }
    } catch { return message.reply('Could not fetch the song. Try again!'); }
    let q = getQ(message.guild.id);
    const isNew = !q;
    if (isNew) q = makeQ(message.guild.id);
    q.textChannel = message.channel;
    q.songs.push(song);
    if (isNew) {
      const conn = joinVoiceChannel({ channelId: vc.id, guildId: message.guild.id, adapterCreator: message.guild.voiceAdapterCreator });
      q.connection = conn;
      const player = createAudioPlayer();
      q.player = player;
      conn.subscribe(player);
      conn.on(VoiceConnectionStatus.Disconnected, async () => {
        try { await Promise.race([entersState(conn, VoiceConnectionStatus.Signalling, 5000), entersState(conn, VoiceConnectionStatus.Connecting, 5000)]); }
        catch { destroyQ(message.guild.id); }
      });
      player.on(AudioPlayerStatus.Idle, () => {
        const qq = getQ(message.guild.id);
        if (!qq) return;
        if (qq.loop === 'song') { playSong(qq); return; }
        if (qq.songs.length) playSong(qq);
        else { if (qq.textChannel) qq.textChannel.send('Queue finished! Thanks for using PattuPetti!'); destroyQ(qq.guildId); }
      });
      player.on('error', err => { console.error(err); const qq = getQ(message.guild.id); if (qq && qq.songs.length) playSong(qq); });
      playSong(q);
      return message.reply('Joined **' + vc.name + '** and playing: **' + song.title + '**');
    }
    return message.reply('Added to queue: **' + song.title + '** (Position #' + q.songs.length + ')');
  }

  if (cmd === 'stop') {
    if (!getQ(message.guild.id)) return message.reply('Nothing is playing!');
    destroyQ(message.guild.id);
    return message.reply('Stopped and cleared the queue!');
  }

  if (cmd === 'pause') {
    const q = getQ(message.guild.id);
    if (!q) return message.reply('Nothing is playing!');
    if (q.player.state.status === AudioPlayerStatus.Playing) { q.player.pause(); return message.reply('Paused! Use `!resume` to continue.'); }
    return message.reply('Already paused!');
  }

  if (cmd === 'resume') {
    const q = getQ(message.guild.id);
    if (!q) return message.reply('Nothing in queue!');
    if (q.player.state.status === AudioPlayerStatus.Paused) { q.player.unpause(); return message.reply('Resumed!'); }
    return message.reply('Not paused!');
  }

  if (cmd === 'skip') {
    const q = getQ(message.guild.id);
    if (!q) return message.reply('Nothing is playing!');
    const skipped = q.currentSong ? q.currentSong.title : 'Unknown';
    const prevLoop = q.loop; q.loop = 'off'; q.player.stop(); q.loop = prevLoop;
    return message.reply('Skipped: **' + skipped + '**');
  }

  if (cmd === 'queue' || cmd === 'q') {
    const q = getQ(message.guild.id);
    if (!q || (!q.currentSong && !q.songs.length)) return message.reply('Queue is empty!');
    let desc = q.currentSong ? '**Now Playing:** ' + q.currentSong.title + '\n\n' : '';
    if (q.songs.length) desc += q.songs.slice(0, 10).map((s, i) => (i + 1) + '. ' + s.title).join('\n');
    else desc += 'No more songs queued.';
    return message.reply({ embeds: [new EmbedBuilder().setColor('#9B59B6').setTitle('Queue').setDescription(desc)] });
  }

  if (cmd === 'volume' || cmd === 'vol') {
    const q = getQ(message.guild.id);
    if (!q) return message.reply('Nothing is playing!');
    const level = parseInt(args[0]);
    if (isNaN(level) || level < 1 || level > 200) return message.reply('Current volume: **' + q.volume + '%**. Usage: `!volume 1-200`');
    q.volume = level;
    if (q.resource && q.resource.volume) q.resource.volume.setVolumeLogarithmic(level / 100);
    return message.reply('Volume set to **' + level + '%**');
  }

  if (cmd === 'np' || cmd === 'nowplaying') {
    const q = getQ(message.guild.id);
    if (!q || !q.currentSong) return message.reply('Nothing is playing!');
    return message.reply('Now playing: **' + q.currentSong.title + '** [' + (q.currentSong.duration || 'Live') + '] - Requested by ' + q.currentSong.requestedBy);
  }

  if (cmd === 'shuffle') {
    const q = getQ(message.guild.id);
    if (!q) return message.reply('Nothing is playing!');
    q.shuffle = !q.shuffle;
    return message.reply('Shuffle: **' + (q.shuffle ? 'ON' : 'OFF') + '**');
  }

  if (cmd === 'loop') {
    const q = getQ(message.guild.id);
    if (!q) return message.reply('Nothing is playing!');
    const modes = ['off', 'song', 'queue'];
    const cur = modes.indexOf(q.loop);
    q.loop = modes[(cur + 1) % 3];
    return message.reply('Loop: **' + q.loop.toUpperCase() + '**');
  }

  if (cmd === 'search') {
    const query = args.join(' ');
    if (!query) return message.reply('Usage: `!search <song name>`');
    try {
      const res = await playdl.search(query, { limit: 5 });
      if (!res.length) return message.reply('No results found!');
      let desc = res.map((s, idx) => (idx + 1) + '. **' + s.title + '** [' + (s.durationRaw || 'N/A') + ']\n   ' + s.url).join('\n\n');
      return message.reply({ embeds: [new EmbedBuilder().setColor('#3498DB').setTitle('Search Results').setDescription(desc + '\n\nUse `!play <URL>` to play!').setFooter({ text: 'PattuPetti Search' })] });
    } catch { return message.reply('Search failed. Try again!'); }
  }

  if (cmd === 'help') {
    const e = new EmbedBuilder().setColor('#FF6B6B').setTitle('PattuPetti - Commands').setDescription('Free Music Bot for Everyone!')
      .addFields(
        { name: 'Prefix Commands (!)', value: '`!play <song/URL>` - Play a song\n`!stop` - Stop & clear queue\n`!pause` - Pause\n`!resume` - Resume\n`!skip` - Skip song\n`!queue` / `!q` - Show queue\n`!volume <1-200>` - Set volume\n`!np` - Now playing\n`!shuffle` - Toggle shuffle\n`!loop` - Cycle loop modes\n`!search <query>` - Search songs', inline: false },
        { name: 'Slash Commands (/)', value: '/play /pause /resume /skip /stop\n/volume /volumeup /volumedown\n/queue /nowplaying /loop /shuffle\n/remove /clear /join /leave /search', inline: false }
      ).setFooter({ text: 'PattuPetti - Made with love!' });
    return message.reply({ embeds: [e] });
  }
});

client.login(process.env.DISCORD_TOKEN);

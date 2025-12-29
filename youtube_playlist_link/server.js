const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.static('public'));

const youtube = google.youtube({
  version: 'v3',
  auth: process.env.YOUTUBE_API_KEY,
});

// 채널 정보 가져오기 (핸들 정보인 customUrl을 반드시 포함)
async function getChannelDetails(channelId) {
    const response = await youtube.channels.list({
        part: 'snippet,statistics,contentDetails',
        id: channelId,
    });
    if (!response.data.items.length) return null;
    const channel = response.data.items[0];
    return {
        channelId: channel.id,
        handle: channel.snippet.customUrl, // [중요] @premierstock 같은 핸들 정보
        title: channel.snippet.title,
        thumbnail: channel.snippet.thumbnails.default.url,
        videoCount: parseInt(channel.statistics.videoCount),
        uploadsPlaylistId: channel.contentDetails.relatedPlaylists.uploads
    };
}

app.get('/api/find-channel', async (req, res) => {
    const { handle } = req.query;
    try {
        const search = await youtube.search.list({ part: 'snippet', type: 'channel', q: handle, maxResults: 1 });
        if (!search.data.items.length) return res.status(404).json({ error: '채널 없음' });
        const details = await getChannelDetails(search.data.items[0].snippet.channelId);
        res.json(details);
    } catch (e) { res.status(500).json({ error: '서버 에러' }); }
});

app.get('/api/find-channel-by-video', async (req, res) => {
    const { videoId } = req.query;
    try {
        const video = await youtube.videos.list({ part: 'snippet', id: videoId });
        if (!video.data.items.length) return res.status(404).json({ error: '영상 없음' });
        const details = await getChannelDetails(video.data.items[0].snippet.channelId);
        res.json(details);
    } catch (e) { res.status(500).json({ error: '정보 조회 실패' }); }
});

app.get('/api/channel-videos', async (req, res) => {
    const { channelId, pageToken } = req.query;
    try {
        const channelInfo = await getChannelDetails(channelId);
        if (!channelInfo) return res.status(404).json({ error: '채널 정보 없음' });
        const response = await youtube.playlistItems.list({
            part: 'snippet,contentDetails',
            playlistId: channelInfo.uploadsPlaylistId,
            maxResults: 50,
            pageToken: pageToken || null
        });
        const videoItems = response.data.items.map(item => ({
            id: item.contentDetails.videoId,
            title: item.snippet.title,
            thumbnail: item.snippet.thumbnails.medium?.url || item.snippet.thumbnails.default.url,
            publishedAt: item.snippet.publishedAt,
        }));
        if (videoItems.length > 0) {
            const ids = videoItems.map(v => v.id).join(',');
            const details = await youtube.videos.list({ part: 'contentDetails', id: ids });
            details.data.items.forEach(d => {
                const target = videoItems.find(v => v.id === d.id);
                if (target) target.duration = d.contentDetails.duration;
            });
        }
        res.json({
            videos: videoItems,
            nextPageToken: response.data.nextPageToken || null,
            totalCount: channelInfo.videoCount
        });
    } catch (e) { res.status(500).json({ error: '목록 조회 실패' }); }
});

app.listen(port, () => console.log(`Server listening at port ${port}`));
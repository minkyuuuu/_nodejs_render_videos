const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

const youtube = google.youtube({
    version: 'v3',
    auth: process.env.YOUTUBE_API_KEY,
});

let cloudStorageData = null;

// 공통 채널 정보 조회 함수 (1포인트 소모)
async function getChannelDetails(channelId) {
    try {
        const response = await youtube.channels.list({
            part: 'snippet,statistics,contentDetails',
            id: channelId,
        });
        if (!response.data.items?.length) return null;
        const channel = response.data.items[0];
        return {
            channelId: channel.id,
            handle: channel.snippet.customUrl,
            title: channel.snippet.title,
            thumbnail: channel.snippet.thumbnails.default.url,
            videoCount: parseInt(channel.statistics.videoCount) || 0,
            uploadsPlaylistId: channel.contentDetails.relatedPlaylists.uploads
        };
    } catch (e) { return null; }
}

app.post('/api/sync-upload', (req, res) => {
    cloudStorageData = req.body.data;
    res.json({ message: '서버 저장 완료' });
});

app.get('/api/sync-download', (req, res) => {
    if (!cloudStorageData) return res.status(404).json({ error: '데이터 없음' });
    res.json({ data: cloudStorageData });
});

// 채널 검색 (핸들 최적화 적용)
app.get('/api/find-channel', async (req, res) => {
    let { handle } = req.query;
    try {
        // 1. UC ID 형식일 때
        if (handle.startsWith('UC') && handle.length > 20) {
            const details = await getChannelDetails(handle);
            if (details) return res.json(details);
        }

        // 2. 핸들(@) 형식일 때 (1포인트)
        if (handle.startsWith('@')) {
            const response = await youtube.channels.list({
                part: 'snippet,statistics,contentDetails',
                forHandle: handle.substring(1)
            });
            if (response.data.items?.length > 0) {
                const channel = response.data.items[0];
                return res.json({
                    channelId: channel.id,
                    handle: channel.snippet.customUrl,
                    title: channel.snippet.title,
                    thumbnail: channel.snippet.thumbnails.default.url,
                    videoCount: parseInt(channel.statistics.videoCount) || 0,
                    uploadsPlaylistId: channel.contentDetails.relatedPlaylists.uploads
                });
            }
        }

        // 3. 마지막 수단: 검색 (100포인트)
        const search = await youtube.search.list({ part: 'snippet', type: 'channel', q: handle, maxResults: 1 });
        if (!search.data.items?.length) return res.status(404).json({ error: '채널 없음' });
        const details = await getChannelDetails(search.data.items[0].id.channelId);
        res.json(details);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/channel-videos', async (req, res) => {
    const { channelId, pageToken } = req.query;
    try {
        // 채널 ID의 'UC'를 'UU'로 바꾸면 업로드 플레이리스트 ID가 됨 (API 호출 절약)
        const uploadsPlaylistId = 'UU' + channelId.substring(2);

        const response = await youtube.playlistItems.list({
            part: 'snippet,contentDetails',
            playlistId: uploadsPlaylistId,
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
        res.json({ videos: videoItems, nextPageToken: response.data.nextPageToken || null });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(port, () => console.log(`Server: http://localhost:${port}`));
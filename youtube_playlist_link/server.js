const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' })); // 데이터 전송 용량 제한 확대
app.use(express.static('public'));

const youtube = google.youtube({
  version: 'v3',
  auth: process.env.YOUTUBE_API_KEY,
});

// [추가] 서버에 임시 저장될 데이터 변수
let cloudStorageData = null;

/**
 * 서버 데이터 동기화 (업로드)
 */
app.post('/api/sync-upload', (req, res) => {
    const { data } = req.body;
    if (!data) return res.status(400).json({ error: '저장할 데이터가 없습니다.' });
    cloudStorageData = data;
    console.log("Data synced to cloud storage.");
    res.json({ message: '서버 저장 완료' });
});

/**
 * 서버 데이터 동기화 (다운로드)
 */
app.get('/api/sync-download', (req, res) => {
    if (!cloudStorageData) return res.status(404).json({ error: '서버에 저장된 데이터가 없습니다.' });
    res.json({ data: cloudStorageData });
});

// 기존 채널 정보 가져오기 (비용 1유닛)
async function getChannelDetails(channelId) {
    const response = await youtube.channels.list({
        part: 'snippet,statistics,contentDetails',
        id: channelId,
    });
    if (!response.data.items || response.data.items.length === 0) return null;
    const channel = response.data.items[0];
    return {
        channelId: channel.id,
        handle: channel.snippet.customUrl,
        title: channel.snippet.title,
        thumbnail: channel.snippet.thumbnails.default.url,
        videoCount: parseInt(channel.statistics.videoCount) || 0,
        uploadsPlaylistId: channel.contentDetails.relatedPlaylists.uploads
    };
}

// [최적화] 채널 찾기 (ID 입력 시 할당량 절약)
app.get('/api/find-channel', async (req, res) => {
    let { handle } = req.query;
    try {
        let channelId = null;
        if (handle.startsWith('UC') && handle.length > 20) {
            channelId = handle;
        } else if (handle.includes('youtube.com/channel/')) {
            const match = handle.match(/channel\/(UC[a-zA-Z0-9_-]{22})/);
            if (match) channelId = match[1];
        }

        if (channelId) {
            const details = await getChannelDetails(channelId);
            if (details) return res.json(details);
        }

        const search = await youtube.search.list({ part: 'snippet', type: 'channel', q: handle, maxResults: 1 });
        if (!search.data.items || search.data.items.length === 0) return res.status(404).json({ error: '채널 없음' });
        
        const foundId = search.data.items[0].id.channelId;
        const details = await getChannelDetails(foundId);
        res.json(details);
    } catch (e) { 
        res.status(500).json({ error: '서버 에러: ' + e.message }); 
    }
});

// 비디오 ID로 채널 찾기
app.get('/api/find-channel-by-video', async (req, res) => {
    const { videoId } = req.query;
    try {
        const video = await youtube.videos.list({ part: 'snippet', id: videoId });
        if (!video.data.items || video.data.items.length === 0) return res.status(404).json({ error: '영상 없음' });
        const details = await getChannelDetails(video.data.items[0].snippet.channelId);
        res.json(details);
    } catch (e) { res.status(500).json({ error: '정보 조회 실패' }); }
});

// 동영상 목록 가져오기
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
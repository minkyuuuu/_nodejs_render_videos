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

// [클라우드 데이터 변수]
let cloudStorageData = null;

app.post('/api/sync-upload', (req, res) => {
    const { data } = req.body;
    if (!data) return res.status(400).json({ error: '데이터 없음' });
    cloudStorageData = data;
    res.json({ message: '서버 저장 완료' });
});

app.get('/api/sync-download', (req, res) => {
    if (!cloudStorageData) return res.status(404).json({ error: '데이터 없음' });
    res.json({ data: cloudStorageData });
});

// 공통 함수: ID로 채널 상세 정보 조회
async function getChannelDetails(channelId) {
    const response = await youtube.channels.list({
        part: 'snippet,statistics,contentDetails',
        id: channelId,
    });
    if (!response.data.items || !response.data.items.length) return null;
    const channel = response.data.items[0];
    return {
        channelId: channel.id,
        handle: channel.snippet.customUrl,
        title: channel.snippet.title,
        thumbnail: channel.snippet.thumbnails.default.url,
        videoCount: parseInt(channel.statistics.videoCount) || 0,
        uploadsPlaylistId: channel.contentDetails.relatedPlaylists?.uploads
    };
}

app.get('/api/find-channel', async (req, res) => {
    let { handle } = req.query;
    try {
        let targetChannelId = null;

        // 1. ID (UC...) 확인
        if (handle.startsWith('UC') && handle.length > 20) {
            targetChannelId = handle;
        } 
        // 2. URL 확인
        else if (handle.includes('youtube.com/channel/')) {
            const match = handle.match(/channel\/(UC[a-zA-Z0-9_-]{22})/);
            if (match) targetChannelId = match[1];
        }

        // ID가 바로 식별되면 조회 후 반환
        if (targetChannelId) {
            const details = await getChannelDetails(targetChannelId);
            if (details) return res.json(details);
            return res.status(404).json({ error: '해당 ID의 채널을 찾을 수 없습니다.' });
        }

        // 3. 핸들(@) 확인
        if (handle.startsWith('@')) {
            try {
                const handleResponse = await youtube.channels.list({ part: 'id', forHandle: handle });
                if (handleResponse.data.items && handleResponse.data.items.length > 0) {
                    targetChannelId = handleResponse.data.items[0].id;
                }
            } catch (err) { console.log("Handle lookup failed:", err.message); }
        }

        // 4. 검색 수행 (ID/핸들 아님)
        if (!targetChannelId) {
            // [수정됨] 검색 결과 갯수를 10개로 늘림
            const search = await youtube.search.list({ 
                part: 'snippet', 
                type: 'channel', 
                q: handle, 
                maxResults: 10 
            });
            
            if (!search.data.items || !search.data.items.length) {
                return res.status(404).json({ error: '검색된 채널이 없습니다.' });
            }
            
            // [추가됨] 검색 결과가 1개면 바로 진행, 여러 개면 목록 반환
            if (search.data.items.length === 1) {
                targetChannelId = search.data.items[0].id.channelId;
            } else {
                const candidates = search.data.items.map(item => ({
                    channelId: item.id.channelId,
                    title: item.snippet.title,
                    description: item.snippet.description,
                    thumbnail: item.snippet.thumbnails.default.url
                }));
                return res.json({ multiple: true, candidates });
            }
        }

        // 5. 최종 상세 조회
        const details = await getChannelDetails(targetChannelId);
        if (!details) return res.status(404).json({ error: '채널 상세 정보를 가져올 수 없습니다.' });
        
        res.json(details);

    } catch (e) { 
        console.error(e);
        res.status(500).json({ error: '서버 에러: ' + e.message }); 
    }
});

app.get('/api/find-channel-by-video', async (req, res) => {
    // ... 기존 코드 유지 (변경 없음)
    const { videoId } = req.query;
    try {
        const video = await youtube.videos.list({ part: 'snippet', id: videoId });
        if (!video.data.items || !video.data.items.length) return res.status(404).json({ error: '영상 없음' });
        const details = await getChannelDetails(video.data.items[0].snippet.channelId);
        res.json(details);
    } catch (e) { res.status(500).json({ error: '정보 조회 실패' }); }
});

app.get('/api/channel-videos', async (req, res) => {
    // ... 기존 코드 유지 (변경 없음)
    const { channelId, pageToken } = req.query;
    try {
        const channelInfo = await getChannelDetails(channelId);
        if (!channelInfo || !channelInfo.uploadsPlaylistId) return res.status(404).json({ error: '채널 정보 또는 업로드 목록 없음' });
        
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
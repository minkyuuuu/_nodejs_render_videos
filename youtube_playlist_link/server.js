const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
require('dotenv').config();

const app = express();
// Render 환경과 로컬 환경 모두 대응하는 포트 설정
const port = process.env.PORT || 3000; 

app.use(cors());
app.use(express.static('public'));

const youtube = google.youtube({
  version: 'v3',
  auth: process.env.YOUTUBE_API_KEY,
});

/**
 * 채널 상세 정보 가져오기 (비용: 1 유닛)
 */
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

/**
 * [최적화] 채널 찾기 라우트
 * 입력값이 ID 형식이면 검색(100 유닛)을 생략하고 조회(1 유닛)를 수행합니다.
 */
app.get('/api/find-channel', async (req, res) => {
    let { handle } = req.query;
    if (!handle) return res.status(400).json({ error: '입력값이 없습니다.' });

    try {
        let channelId = null;

        // 1. 입력값이 채널 ID 직접 입력인 경우 (예: UCZQ...)
        if (handle.startsWith('UC') && handle.length > 20) {
            channelId = handle;
        } 
        // 2. 입력값이 채널 ID 기반 URL인 경우 (예: youtube.com/channel/UC...)
        else if (handle.includes('youtube.com/channel/')) {
            const match = handle.match(/channel\/(UC[a-zA-Z0-9_-]{22})/);
            if (match) channelId = match[1];
        }

        // 채널 ID를 찾았다면 검색(100 유닛) 없이 즉시 조회(1 유닛)
        if (channelId) {
            const details = await getChannelDetails(channelId);
            if (details) return res.json(details);
            else return res.status(404).json({ error: '채널 정보를 찾을 수 없습니다.' });
        }

        // 3. 핸들(@)이나 이름인 경우에만 검색 실행 (비용: 100 유닛)
        console.log("Searching for handle (100 units):", handle);
        const search = await youtube.search.list({ 
            part: 'snippet', 
            type: 'channel', 
            q: handle, 
            maxResults: 1 
        });

        if (!search.data.items || search.data.items.length === 0) {
            return res.status(404).json({ error: '검색 결과가 없습니다.' });
        }
        
        const foundId = search.data.items[0].id.channelId;
        const details = await getChannelDetails(foundId);
        res.json(details);

    } catch (e) { 
        console.error("Find Channel Error:", e.message);
        // Quota 에러인 경우 클라이언트에 더 명확히 알림
        const errorMsg = e.message.includes('quota') ? 'API 일일 사용량이 초과되었습니다.' : '서버 에러가 발생했습니다.';
        res.status(500).json({ error: errorMsg }); 
    }
});

/**
 * 영상 URL로 채널 찾기 (비용: 1 유닛)
 */
app.get('/api/find-channel-by-video', async (req, res) => {
    const { videoId } = req.query;
    try {
        const video = await youtube.videos.list({ part: 'snippet', id: videoId });
        if (!video.data.items || video.data.items.length === 0) return res.status(404).json({ error: '영상을 찾을 수 없습니다.' });
        const details = await getChannelDetails(video.data.items[0].snippet.channelId);
        res.json(details);
    } catch (e) { 
        console.error("Find By Video Error:", e.message);
        res.status(500).json({ error: '정보 조회 실패' }); 
    }
});

/**
 * 채널 동영상 목록 가져오기 (비용: 페이지당 2 유닛)
 */
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

        // 영상 길이 조회를 위한 추가 호출 (1 유닛)
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
    } catch (e) { 
        console.error("Fetch Videos Error:", e.message);
        res.status(500).json({ error: '목록 조회 중 오류 발생' }); 
    }
});

app.listen(port, () => console.log(`Server listening at port ${port}`));
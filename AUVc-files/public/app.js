let socket;
let localStream;
let audioContext;
let peerConnections = {}; // { socketId: { pc, panner, remoteStream } }
let localSocketId;
let localUsername;
let currentRoom;
let isMuted = false;

const iceServersConfig = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

async function initializeSession() {
    localUsername = document.getElementById('username').value.trim();
    currentRoom = document.getElementById('roomCode').value.trim().toUpperCase();

    if (!localUsername || currentRoom.length !== 6) {
        alert('Please fill in your username and a valid 6-character room code.');
        return;
    }

    try {
        // Request iOS microphone access
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        
        // Initialize Web Audio API context (must be triggered by user action for iOS)
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        audioContext = new AudioContextClass();
        if (audioContext.state === 'suspended') {
            await audioContext.resume();
        }

        socket = io();
        setupSocketListeners();

    } catch (err) {
        alert('Microphone permission is required for proximity chat. Check your browser/iOS settings.');
        console.error('Media error:', err);
    }
}

function setupSocketListeners() {
    socket.on('connect', () => {
        localSocketId = socket.id;
        socket.emit('join-room', { username: localUsername, room: currentRoom });

        document.getElementById('setup-screen').classList.add('hidden');
        document.getElementById('active-screen').classList.remove('hidden');
        document.getElementById('display-name').innerText = localUsername;
        document.getElementById('display-room').innerText = currentRoom;
        document.getElementById('status').innerText = 'Connected to Signaling Server';
    });

    socket.on('room-update', async (roomPlayers) => {
        for (const targetId in roomPlayers) {
            if (targetId === localSocketId) continue;

            // Establish WebRTC connection with new peers if not already present
            if (!peerConnections[targetId]) {
                await createPeerConnection(targetId, true);
            }
        }
        updateSpatialAudioTransforms(roomPlayers);
    });

    socket.on('offer', async ({ senderId, offer }) => {
        if (!peerConnections[senderId]) {
            await createPeerConnection(senderId, false);
        }
        await peerConnections[senderId].pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await peerConnections[senderId].pc.createAnswer();
        await peerConnections[senderId].pc.setLocalDescription(answer);
        socket.emit('answer', { targetId: senderId, answer });
    });

    socket.on('answer', async ({ senderId, answer }) => {
        if (peerConnections[senderId]) {
            await peerConnections[senderId].pc.setRemoteDescription(new RTCSessionDescription(answer));
        }
    });

    socket.on('ice-candidate', async ({ senderId, candidate }) => {
        if (peerConnections[senderId] && candidate) {
            try {
                await peerConnections[senderId].pc.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (e) {
                console.error('Error adding received ice candidate', e);
            }
        }
    });
}

async function createPeerConnection(targetId, isInitiator) {
    const pc = new RTCPeerConnection(iceServersConfig);
    
    // Create spatial audio nodes for this peer
    const panner = audioContext.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 1;
    panner.maxDistance = 20;
    panner.rolloffFactor = 1;
    
    const gainNode = audioContext.createGain();
    
    // Connect panner -> gain -> audio output hardware
    panner.connect(gainNode);
    gainNode.connect(audioContext.destination);

    peerConnections[targetId] = { pc, panner, gainNode };

    // Add local mic tracks to peer connection
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('ice-candidate', { targetId, candidate: event.candidate });
        }
    };

    pc.ontrack = (event) => {
        const remoteStream = event.streams[0];
        const remoteAudio = document.createElement('audio');
        remoteAudio.srcObject = remoteStream;
        remoteAudio.autoplay = true;
        remoteAudio.playsInline = true; // Crucial requirement for iOS Safari

        const sourceNode = audioContext.createMediaStreamSource(remoteStream);
        sourceNode.connect(panner);
    };

    if (isInitiator) {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('offer', { targetId, offer });
    }
}

function updateSpatialAudioTransforms(roomPlayers) {
    const localPlayer = roomPlayers[localSocketId];
    if (!localPlayer) return;

    for (const targetId in roomPlayers) {
        if (targetId === localSocketId) continue;
        const remotePlayer = roomPlayers[targetId];
        const peer = peerConnections[targetId];

        if (peer && peer.panner && peer.gainNode) {
            const dx = remotePlayer.x - localPlayer.x;
            const dy = remotePlayer.y - localPlayer.y;

            // Update 3D coordinates on Web Audio Panner
            peer.panner.positionX.setValueAtTime(dx, audioContext.currentTime);
            peer.panner.positionY.setValueAtTime(dy, audioContext.currentTime);
            peer.panner.positionZ.setValueAtTime(0, audioContext.currentTime);

            // Apply game state constraints (Meetings or Ghost rules)
            if (localPlayer.inMeeting || remotePlayer.inMeeting) {
                peer.gainNode.gain.setValueAtTime(1.0, audioContext.currentTime); // Global volume in meetings
            } else if (localPlayer.isDead && !remotePlayer.isDead) {
                peer.gainNode.gain.setValueAtTime(0.0, audioContext.currentTime); // Dead cannot hear living
            } else {
                // Distance volume attenuation scaling
                const distance = Math.sqrt(dx * dx + dy * dy);
                const volume = Math.max(0, 1 - (distance / 12)); // 12 unit cutoff radius
                peer.gainNode.gain.setValueAtTime(volume, audioContext.currentTime);
            }
        }
    }
}

function toggleMute() {
    isMuted = !isMuted;
    if (localStream) {
        localStream.getAudioTracks()[0].enabled = !isMuted;
    }
    const btn = document.getElementById('mute-btn');
    btn.innerText = isMuted ? 'Unmute Mic' : 'Mute Mic';
    btn.style.background = isMuted ? '#ff453a' : '#30d158';
}

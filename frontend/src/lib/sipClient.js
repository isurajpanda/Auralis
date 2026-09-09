// Full SIP.js wrapper — uses Asterisk WSS via nginx at wss://x.lan/asterisk/ws when available,
// otherwise Dialer falls back to backend signaling (useSip.js via /ws/signal)
import { UserAgent, Registerer, Inviter, SessionState } from 'sip.js'
import { SIP_WS_URL, SIP_DOMAIN } from './config.js'

export class SipClient {
  constructor({ extension, password, server = SIP_WS_URL, displayName }) {
    this.extension = extension
    this.password = password
    this.server = server
    this.displayName = displayName || extension
    this.ua = null
    this.registerer = null
    this.session = null
    this.onIncoming = null
    this.onStatus = null
  }

  async connect() {
    const uri = UserAgent.makeURI(`sip:${this.extension}@${SIP_DOMAIN}`)
    if (!uri) throw new Error('Invalid SIP URI')
    this.ua = new UserAgent({
      uri,
      displayName: this.displayName,
      authorizationUsername: this.extension,
      authorizationPassword: this.password,
      transportOptions: {
        server: this.server,
        // Asterisk needs traceSip for debugging
        traceSip: true
      },
      sessionDescriptionHandlerFactoryOptions: {
        peerConnectionOptions: {
          iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
        }
      }
    })
    // Incoming invite
    this.ua.delegate = {
      onInvite: (invitation) => {
        this.session = invitation
        this.session.stateChange.addListener((state) => {
          this.onStatus?.(state)
        })
        // Auto-tap remote audio for detection: attach to <audio>
        this.onIncoming?.(invitation)
      }
    }
    await this.ua.start()
    this.registerer = new Registerer(this.ua)
    await this.registerer.register()
    this.onStatus?.('registered')
    return this.ua
  }

  async makeCall(targetExt) {
    if (!this.ua) throw new Error('Not connected')
    const target = UserAgent.makeURI(`sip:${targetExt}@${SIP_DOMAIN}`)
    if (!target) throw new Error('Invalid target')
    this.session = new Inviter(this.ua, target, {
      sessionDescriptionHandlerOptions: {
        constraints: { audio: true, video: false }
      }
    })
    this.session.stateChange.addListener((state) => this.onStatus?.(state))
    await this.session.invite()
    return this.session
  }

  async hangup() {
    try {
      if (this.session) {
        if (this.session.state === SessionState.Established) await this.session.bye()
        else if (this.session.state === SessionState.Establishing) await this.session.cancel()
      }
    } finally {
      this.session = null
    }
  }

  async disconnect() {
    try { await this.registerer?.unregister() } catch {}
    try { await this.ua?.stop() } catch {}
  }
}

export default SipClient
// Usage in Dialer:
// import SipClient from '../lib/sipClient.js'
// const client = new SipClient({ extension: '1001', password: '1001pass' })
// await client.connect(); await client.makeCall('1002')

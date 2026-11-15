export const FLAP_START = 0x2a;
export const FLAP_SIGNON = 0x01;
export const FLAP_DATA = 0x02;
export const FLAP_SIGNOFF = 0x04;
export const FLAP_KEEPALIVE = 0x05;
export const FLAP_VERSION = 1;
export const FLAP_HEADER_LENGTH = 6;
export const FLAP_MAX_PAYLOAD = 0xfff9;

export const SNAC_HEADER_LENGTH = 10;
export const SNAC_FLAG_EXTENDED = 0x8000;
export const SERVER_REQUEST_ID = 0x80000000;

export const FAMILY_OSERVICE = 0x0001;
export const FAMILY_LOCATE = 0x0002;
export const FAMILY_BUDDY = 0x0003;
export const FAMILY_ICBM = 0x0004;
export const FAMILY_POPUP = 0x0008;
export const FAMILY_BUCP = 0x0017;

export const POPUP_DISPLAY = 0x0002;
export const POPUP_TLV_MESSAGE = 0x0001;
export const POPUP_TLV_URL = 0x0002;
export const POPUP_TLV_WIDTH = 0x0003;
export const POPUP_TLV_HEIGHT = 0x0004;

export const OSERVICE_ERR = 0x0001;
export const OSERVICE_CLIENT_ONLINE = 0x0002;
export const OSERVICE_HOST_ONLINE = 0x0003;
export const OSERVICE_SERVICE_REQUEST = 0x0004;
export const OSERVICE_SERVICE_RESPONSE = 0x0005;
export const OSERVICE_RATE_PARAMS_QUERY = 0x0006;
export const OSERVICE_RATE_PARAMS_REPLY = 0x0007;
export const OSERVICE_RATE_PARAMS_SUB_ADD = 0x0008;
export const OSERVICE_RATE_PARAM_CHANGE = 0x000a;
export const OSERVICE_USER_INFO_QUERY = 0x000e;
export const OSERVICE_USER_INFO_UPDATE = 0x000f;
export const OSERVICE_EVIL_NOTIFICATION = 0x0010;
export const OSERVICE_IDLE_NOTIFICATION = 0x0011;
export const OSERVICE_CLIENT_VERSIONS = 0x0017;
export const OSERVICE_SET_USER_INFO_FIELDS = 0x001e;
export const OSERVICE_BART_REPLY = 0x0021;
// Never sent: its nil reply (foodgroup/oservice.go:365) fails to encode and the server closes the socket.
export const OSERVICE_PROBE_REQ = 0x001f;
export const FOOD_GROUP_VERSION = 1;
export const OSERVICE_MULTI_INSTANCE_VERSION = 4;
export const CLIENT_TOOL_ID = 0x0110;
export const CLIENT_TOOL_VERSION = 0x0629;

export const SERVICE_TLV_ROOM_INFO = 0x0001;
export const SERVICE_TLV_RECONNECT_HERE = 0x0005;
export const SERVICE_TLV_COOKIE = 0x0006;
export const SERVICE_TLV_USE_SSL = 0x008c;
export const SERVICE_TLV_SSL_STATE = 0x008e;
export const SERVICE_COOKIE_TTL_MS = 60_000;

export const RATE_CODE_ALERT = 2;
export const RATE_CODE_LIMITED = 3;
export const RATE_CODE_CLEAR = 4;
export const RATE_CLASS_RECORD_LENGTH_V2 = 35;
export const RATE_CLASS_IM = 3;

export const USER_INFO_FLAGS = 0x0001;
export const USER_FLAG_AWAY = 0x0020;
export const USER_FLAG_WIRELESS = 0x0080;
export const USER_FLAG_BOT = 0x0400;
export const USER_INFO_STATUS = 0x0006;
export const USER_STATUS_INVISIBLE = 0x00000100;
export const USER_INFO_EXTERNAL_IP = 0x000a;
export const USER_INFO_CAPABILITIES = 0x000d;
export const USER_INFO_INSTANCE = 0x0014;
export const USER_INFO_BART = 0x001d;
export const USER_INFO_PRIMARY_INSTANCE = 0x0028;
export const USER_INFO_EXTERNAL_IP_TEXT = 0x100a;

export const LOCATE_SET_INFO = 0x0004;
export const LOCATE_TLV_AWAY_TEXT = 0x0004;
export const LOCATE_TLV_CAPABILITIES = 0x0005;
export const CAPABILITY_LENGTH = 16;
export const CAP_CHAT: Uint8Array = Uint8Array.of(
  0x74, 0x8f, 0x24, 0x20, 0x62, 0x87, 0x11, 0xd1, 0x82, 0x22, 0x44, 0x45, 0x53, 0x54, 0x00, 0x00,
);
export const CAP_UTF8_MESSAGES: Uint8Array = Uint8Array.of(
  0x09, 0x46, 0x13, 0x4e, 0x4c, 0x7f, 0x11, 0xd1, 0x82, 0x22, 0x44, 0x45, 0x53, 0x54, 0x00, 0x00,
);
export const CAP_SEND_FILE: Uint8Array = Uint8Array.of(
  0x09, 0x46, 0x13, 0x43, 0x4c, 0x7f, 0x11, 0xd1, 0x82, 0x22, 0x44, 0x45, 0x53, 0x54, 0x00, 0x00,
);
export const CAP_DIRECT_IM: Uint8Array = Uint8Array.of(
  0x09, 0x46, 0x13, 0x45, 0x4c, 0x7f, 0x11, 0xd1, 0x82, 0x22, 0x44, 0x45, 0x53, 0x54, 0x00, 0x00,
);
export const CAP_GET_FILE: Uint8Array = Uint8Array.of(
  0x09, 0x46, 0x13, 0x48, 0x4c, 0x7f, 0x11, 0xd1, 0x82, 0x22, 0x44, 0x45, 0x53, 0x54, 0x00, 0x00,
);
export const CAP_BUDDY_ICON: Uint8Array = Uint8Array.of(
  0x09, 0x46, 0x13, 0x46, 0x4c, 0x7f, 0x11, 0xd1, 0x82, 0x22, 0x44, 0x45, 0x53, 0x54, 0x00, 0x00,
);
export const CAP_MOBILE_CLIENT: Uint8Array = Uint8Array.of(
  0x09, 0x46, 0x13, 0x23, 0x4c, 0x7f, 0x11, 0xd1, 0x82, 0x22, 0x44, 0x45, 0x53, 0x54, 0x00, 0x00,
);

export const BUDDY_ADD_BUDDIES = 0x0004;
export const BUDDY_DEL_BUDDIES = 0x0005;
export const BUDDY_ARRIVED = 0x000b;
export const BUDDY_DEPARTED = 0x000c;

export const ICBM_ERR = 0x0001;
export const ICBM_MSG_TO_HOST = 0x0006;
export const ICBM_MSG_TO_CLIENT = 0x0007;
export const ICBM_EVIL_REQUEST = 0x0008;
export const ICBM_EVIL_REPLY = 0x0009;
export const ICBM_CLIENT_ERR = 0x000b;
export const ICBM_HOST_ACK = 0x000c;
export const ICBM_OFFLINE_RETRIEVE = 0x0010;
export const ICBM_CLIENT_EVENT = 0x0014;
export const ICBM_OFFLINE_RETRIEVE_REPLY = 0x0017;

export const ICBM_CHANNEL_IM = 1;
export const ICBM_CHANNEL_RENDEZVOUS = 2;
export const ICBM_TLV_IM_DATA = 0x0002;
export const ICBM_TLV_REQUEST_HOST_ACK = 0x0003;
export const ICBM_TLV_AUTO_RESPONSE = 0x0004;
export const ICBM_TLV_STORE = 0x0006;
export const ICBM_TLV_SEND_TIME = 0x0016;
export const ICBM_FRAGMENT_CAPS = 5;
export const ICBM_FRAGMENT_TEXT = 1;
export const ICBM_FRAGMENT_VERSION = 1;
export const ICBM_FRAGMENT_CAPS_TEXT: Uint8Array = Uint8Array.of(0x01, 0x01, 0x02);
export const ICBM_CHARSET_ASCII = 0;
export const ICBM_CHARSET_UNICODE = 2;
export const ICBM_CHARSET_LATIN1 = 3;
export const ICBM_EVENT_NONE = 0;
export const ICBM_EVENT_TYPED = 1;
export const ICBM_EVENT_TYPING = 2;
export const ICBM_ERROR_NOT_LOGGED_ON = 0x0004;
export const ICBM_ERROR_REQUEST_DENIED = 0x000d;

export const BUCP_LOGIN_REQUEST = 0x0002;
export const BUCP_LOGIN_RESPONSE = 0x0003;
export const BUCP_CHALLENGE_REQUEST = 0x0006;
export const BUCP_CHALLENGE_RESPONSE = 0x0007;

export const LOGIN_TLV_SCREEN_NAME = 0x0001;
export const LOGIN_TLV_CLIENT_ID = 0x0003;
export const LOGIN_TLV_RECONNECT_HERE = 0x0005;
export const LOGIN_TLV_COOKIE = 0x0006;
export const LOGIN_TLV_ERROR = 0x0008;
export const LOGIN_TLV_PASSWORD_HASH = 0x0025;
export const LOGIN_TLV_MULTI_CONN = 0x004a;
export const LOGIN_TLV_SSL_STATE = 0x008e;
export const LOGIN_TLV_TOKEN_TTL = 0x133a;
export const TOKEN_TTL_MAX_SECONDS = 31_536_000;
export const MULTI_CONN_SINGLE = 0x03;
export const MULTI_CONN_RECENT = 0x01;
export const LOGIN_HASH_SUFFIX = 'AOL Instant Messenger (SM)';

export const LOGIN_ERR_UNKNOWN_NAME = 0x0001;
export const LOGIN_ERR_BAD_PASSWORD = 0x0005;
export const LOGIN_ERR_INVALID_ACCOUNT = 0x0007;
export const LOGIN_ERR_DELETED = 0x0008;
export const LOGIN_ERR_EXPIRED = 0x0009;
export const LOGIN_ERR_SUSPENDED = 0x0011;
export const LOGIN_ERR_RATE_LIMITED = 0x001d;
export const LOGIN_ERR_SUSPENDED_AGE = 0x0022;

export const SIGNOFF_TLV_DISCONNECT_REASON = 0x0009;

export const KEEPALIVE_INTERVAL_MS = 60_000;
export const PROBE_INTERVAL_MS = 90_000;
export const PROBE_TIMEOUT_MS = 20_000;
export const CONNECT_TIMEOUT_MS = 20_000;
export const REQUEST_TIMEOUT_MS = 20_000;
export const RECEIPT_TIMEOUT_MS = 10_000;

export const BACKOFF_BASE_MS = 2_000;
export const BACKOFF_FACTOR = 2;
export const BACKOFF_CAP_MS = 120_000;
export const BACKOFF_JITTER = 0.2;
export const BACKOFF_FLOOR_MS = 60_000;
export const BACKOFF_FLOOR_AFTER_FAILURES = 3;
export const SERVER_DISCONNECT_BACKOFF_MS = 60_000;
export const STABLE_ONLINE_MS = 60_000;
export const LOGIN_BUDGET_PER_MINUTE = 8;
export const LOGIN_STAGGER_MS = 2_000;
export const RATE_RECENT_MS = 30_000;
export const PASSWORD_CHECK_CACHE_MS = 24 * 60 * 60 * 1000;
export const TYPING_KEEPALIVE_MS = 8_000;
export const TYPING_MAX_MS = 120_000;

export const FAMILY_CHATNAV = 0x000d;
export const FAMILY_CHAT = 0x000e;
export const SERVICE_REQUEST_TIMEOUT_MS = 10_000;

export const CHATNAV_ERR = 0x0001;
export const CHATNAV_REQUEST_ROOM_INFO = 0x0004;
export const CHATNAV_CREATE_ROOM = 0x0008;
export const CHATNAV_NAV_INFO = 0x0009;
export const CHATNAV_TLV_ROOM_INFO = 0x0004;
export const CHATNAV_ERR_NO_MATCH = 0x0014;
export const CHATNAV_CREATE_COOKIE = 'create';
export const CHATNAV_CREATE_INSTANCE = 0xffff;
export const CHATNAV_CREATE_DETAIL = 0x01;
export const CHATNAV_ROOM_DETAIL = 0x02;
export const CHATNAV_CREATE_ATTEMPTS = 3;
export const CHATNAV_COOKIE_ATTEMPTS = 2;
export const CHATNAV_RETRY_BASE_MS = 500;
export const ROOM_TLV_NAME = 0x00d3;
export const ROOM_TLV_CHARSET = 0x00d6;
export const ROOM_TLV_LANG = 0x00d7;
export const ROOM_TLV_CREATE_TIME = 0x00ca;
export const ROOM_TLV_MAX_OCCUPANCY = 0x00d2;

export const CHAT_ROOM_INFO_UPDATE = 0x0002;
export const CHAT_USERS_JOINED = 0x0003;
export const CHAT_USERS_LEFT = 0x0004;
export const CHAT_MSG_TO_HOST = 0x0005;
export const CHAT_MSG_TO_CLIENT = 0x0006;
export const CHAT_CHANNEL = 0x0003;
export const CHAT_TLV_PUBLIC = 0x0001;
export const CHAT_TLV_WHISPER_TO = 0x0002;
export const CHAT_TLV_SENDER = 0x0003;
export const CHAT_TLV_MESSAGE = 0x0005;
export const CHAT_TLV_REFLECT = 0x0006;
export const CHAT_MSG_TLV_TEXT = 0x0001;
export const CHAT_MSG_TLV_ENCODING = 0x0002;
export const CHAT_MSG_TLV_LANG = 0x0003;
export const CHAT_ENCODING_ASCII = 'us-ascii';
export const CHAT_LANG = 'en';
export const CHAT_SEND_RATE_CLASS = 2;
export const CHAT_RATE_CLASS_IDS = [1, 2, 3, 4, 5];
export const CHAT_CLIENT_TOOL_ID = 0x0110;
export const CHAT_CLIENT_TOOL_VERSION = 0x0629;

export const ROOM_JOIN_MAX_BYTES = 180;
export const ROOM_MAX_TEXT_BYTES = 1024;
export const ROOM_QUEUE_MAX = 50;
export const ROOM_READY_TIMEOUT_MS = 15_000;
export const ROOM_RECEIPT_TIMEOUT_MS = 10_000;
export const ROOM_LIMITED_HOLD_MS = 120_000;
export const ROOM_SERVER_SENDER = 'onlinehost';
export const ROOM_REJOIN_BASE_MS = 2_000;
export const ROOM_REJOIN_CAP_MS = 120_000;
export const ROOM_REJOIN_STABLE_MS = 60_000;
export const ROOM_MISSING_RETRY_MS = 300_000;
export const ROOM_SESSION_MAX_FAILURES = 5;

export const ICBM_TLV_RENDEZVOUS = 0x0005;
export const RDV_TYPE_PROPOSE = 0x0000;
export const RDV_TYPE_CANCEL = 0x0001;
export const RDV_TYPE_ACCEPT = 0x0002;
export const RDV_FRAGMENT_MIN_BYTES = 26;
export const RDV_TLV_RDV_IP = 0x0002;
export const RDV_TLV_REQUESTER_IP = 0x0003;
export const RDV_TLV_VERIFIED_IP = 0x0004;
export const RDV_TLV_PORT = 0x0005;
export const RDV_TLV_SEQUENCE = 0x000a; // u16 0x0001 in a proposal
export const RDV_TLV_CANCEL_REASON = 0x000b;
export const RDV_CANCEL_DECLINED = 0x0001; // "recipient user declined", wire/snacs.go ICBMRdvCancelReasonsUserCancel
export const RDV_TLV_INVITATION = 0x000c;
export const RDV_TLV_CHARSET = 0x000d;
export const RDV_TLV_LANG = 0x000e;
export const RDV_TLV_REQUEST_HOST_CHECK = 0x000f;
export const RDV_TLV_USE_PROXY = 0x0010;
export const RDV_TLV_IP_XOR = 0x0016;
export const RDV_TLV_PORT_XOR = 0x0017;
export const RDV_CANCEL_TIMEOUT = 0x0002;
export const RDV_CANCEL_ELSEWHERE = 0x0003;
export const RDV_FILE_ONE = 0x0001;
export const RDV_FILE_SEVERAL = 0x0002;
// The first field of tag 0x2711 in a Get File proposal.
export const RDV_FILE_GET = 0x0012;
export const MAX_OFFER_BYTES = 0xffff_ffff;
export const RDV_TLV_SERVICE_DATA = 0x2711;

export const ODC_HEADER_BYTES = 76;
export const ODC_HEADER_MAX_BYTES = 256;
export const ODC_FLAG_AUTO = 0x0001;
export const ODC_FLAG_TYPING_NOTICE = 0x0002;
export const ODC_FLAG_TYPED = 0x0004;
export const ODC_FLAG_TYPING = 0x0008;
// Some clients keep these bits on each frame they send.
export const ODC_FLAG_HELLO = 0x0060;
// The defaults of a Direct IM connection. The host sets its own limits.
export const DIRECT_IM_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
export const DIRECT_IM_MAX_ATTACHMENTS = 16;
export const DIRECT_IM_MAX_TEXT_BYTES = 256 * 1024;
export const DIRECT_IM_MAX_SESSION_BYTES = 1024 * 1024 * 1024;
// The defaults of a Get File connection. The host sets its own limits.
export const GET_FILE_MAX_LISTING_BYTES = 16 * 1024 * 1024;
export const GET_FILE_MAX_ENTRIES = 65_535;
export const GET_FILE_MAX_SERVING = 4;
export const GET_FILE_MAX_NAME_BYTES = 1024;

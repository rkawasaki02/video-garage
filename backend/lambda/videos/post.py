import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import boto3

dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table(os.environ['TABLE_NAME_VIDEOS'])
ssm = boto3.client('ssm')

# Twitch への問い合わせ1回あたりのタイムアウト（秒）
TWITCH_TIMEOUT = 3
# VOD サムネのテンプレート（%{width}x%{height}）に埋めるサイズ
VOD_THUMB_SIZE = ('640', '360')

# ハンドラ外にキャッシュし、ウォームスタート時は SSM / トークン取得を省略する
_twitch_credentials = None
_twitch_token = None
_twitch_token_expires_at = 0


def detect_twitch(url):
    # frontend/platform.js と同じ順序で判定する（clip → VOD → channel）
    clip = re.search(r'twitch\.tv/\w+/clip/([A-Za-z0-9_-]+)', url)
    if clip:
        return 'clip', clip.group(1)
    vod = re.search(r'twitch\.tv/videos/(\d+)', url)
    if vod:
        return 'vod', vod.group(1)
    channel = re.search(r'twitch\.tv/([A-Za-z0-9_]+)', url)
    if channel:
        return 'channel', channel.group(1)
    return None


def get_twitch_credentials():
    global _twitch_credentials
    if _twitch_credentials is None:
        names = [os.environ['TWITCH_CLIENT_ID_PARAM'], os.environ['TWITCH_CLIENT_SECRET_PARAM']]
        res = ssm.get_parameters(Names=names, WithDecryption=True)
        values = {p['Name']: p['Value'] for p in res['Parameters']}
        _twitch_credentials = (values[names[0]], values[names[1]])
    return _twitch_credentials


def get_twitch_token():
    global _twitch_token, _twitch_token_expires_at
    # 期限切れ60秒前には取り直す
    if _twitch_token and time.time() < _twitch_token_expires_at - 60:
        return _twitch_token

    client_id, client_secret = get_twitch_credentials()
    data = urllib.parse.urlencode({
        'client_id': client_id,
        'client_secret': client_secret,
        'grant_type': 'client_credentials'
    }).encode()
    req = urllib.request.Request('https://id.twitch.tv/oauth2/token', data=data, method='POST')
    with urllib.request.urlopen(req, timeout=TWITCH_TIMEOUT) as res:
        body = json.loads(res.read())

    _twitch_token = body['access_token']
    _twitch_token_expires_at = time.time() + body['expires_in']
    return _twitch_token


def twitch_api(path, params):
    global _twitch_token
    client_id, _ = get_twitch_credentials()
    req = urllib.request.Request(
        f'https://api.twitch.tv/helix/{path}?{urllib.parse.urlencode(params)}',
        headers={
            'Client-Id': client_id,
            'Authorization': f'Bearer {get_twitch_token()}'
        }
    )
    try:
        with urllib.request.urlopen(req, timeout=TWITCH_TIMEOUT) as res:
            return json.loads(res.read()).get('data', [])
    except urllib.error.HTTPError as e:
        # トークンが失効していた場合、次回の呼び出しで取り直す
        if e.code == 401:
            _twitch_token = None
        raise


def fetch_twitch_thumbnail(kind, twitch_id):
    if kind == 'clip':
        data = twitch_api('clips', {'id': twitch_id})
        url = data[0]['thumbnail_url'] if data else ''
    elif kind == 'vod':
        data = twitch_api('videos', {'id': twitch_id})
        url = data[0]['thumbnail_url'] if data else ''
        # 配信中の VOD はサムネが空、または処理中の画像になる
        if '_404/' in url:
            url = ''
        url = url.replace('%{width}', VOD_THUMB_SIZE[0]).replace('%{height}', VOD_THUMB_SIZE[1])
    else:
        # 配信プレビューはすぐ変わって消えるため、プロフィール画像を使う
        data = twitch_api('users', {'login': twitch_id})
        url = data[0]['profile_image_url'] if data else ''

    return url if url.startswith('https://') else ''


def resolve_thumbnail(user_id, body):
    twitch = detect_twitch(body['url'])
    if not twitch:
        return ''

    # 並び替え・タブ移動でも POST が呼ばれるため、取得済みのサムネは引き継ぎ Twitch を呼ばない
    existing = table.get_item(Key={'userId': user_id, 'videoId': body['videoId']}).get('Item', {})
    if existing.get('thumbnailUrl') and existing.get('url') == body['url']:
        return existing['thumbnailUrl']

    # Twitch が落ちていても動画の保存は成功させる（サムネは空のまま）
    try:
        return fetch_twitch_thumbnail(*twitch)
    except Exception as e:
        print(f'failed to fetch twitch thumbnail: {e!r}')
        return ''


def lambda_handler(event, context):
    # CognitoのJWTトークンからuserIdを取得
    user_id = event['requestContext']['authorizer']['jwt']['claims']['sub']

    # リクエストボディをパース
    body = json.loads(event['body'])

    # 必須パラメータのチェック
    if 'videoId' not in body or 'url' not in body or 'type' not in body or 'tabId' not in body:
        return {
            'statusCode': 400,
            'headers': {
                'Access-Control-Allow-Origin': 'https://videogarage.jp',
                'Content-Type': 'application/json'
            },
            'body': json.dumps({'error': 'missing required fields'})
        }

    thumbnail_url = resolve_thumbnail(user_id, body)

    # DynamoDBに動画を保存
    table.put_item(
        Item={
            'userId': user_id,
            'videoId': body['videoId'],
            'url': body['url'],
            'type': body['type'],
            'tabId': body['tabId'],
            'title': body.get('title', ''),
            'addedAt': body['addedAt'],
            'order': body.get('order', 0),
            'thumbnailUrl': thumbnail_url
        }
    )

    return {
        'statusCode': 201,
        'headers': {
            'Access-Control-Allow-Origin': 'https://videogarage.jp',
            'Content-Type': 'application/json'
        },
        'body': json.dumps({'message': 'video added', 'thumbnailUrl': thumbnail_url})
    }

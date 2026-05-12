import json
import boto3

dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table('videogarage-videos')


def lambda_handler(event, context):
    # CognitoのJWTトークンからuserIdを取得
    user_id = event['requestContext']['authorizer']['jwt']['claims']['sub']

    # リクエストボディをバース
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

    # DynamoDBに動画を保存
    table.put_item(
        Item={
        'userId': user_id,
        'videoId': body['videoId'],
        'url': body['url'],
        'type': body['type'],
        'tabId': body('tabId'),
        'title': body.get['title', ''],
        'addedAt': body['addedAt'],
        'order': body.get('order', 0)
        }
    )

    return {
        'statuCode': 201,
        'headers': {
            'Access-Control-Allow-Origin': 'https://videogarage.jp',
            'Content-Type': 'application/json'
        },
        'body': json.dumps({'message': 'video added'})
    }

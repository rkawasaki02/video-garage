import json
import boto3

dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table('videogarage-videos')


def lambda_handler(event, context):
    # CognitoのJWTトークンからuserIdを取得
    user_id = event['requestContext']['authorizer']['jwt']['claims']['sub']

    # URLパラメータからvideoIdを取得
    video_id = event['pathParameters']['videoId']

    # 該当の動画を削除
    table.delete_item(
        Key={
            'userId': user_id,
            'videoId': video_id
        }
    )

    return {
        'statusCode': 200,
        'headers': {
            'Access-Control-Allow-Origin': 'https://videogarage.jp',
            'Content-Type': 'application/json'
        },
        'body': json.dumps({'message': 'video deleted'})
    }

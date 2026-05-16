import json
import boto3
from bote3.dynamodb.conditions import Key

dynamodb = boto3.resource('dynamodb')
tabs_table = dynamodb.Table('videogarage-tabs')
videos_table = dynamodb.Table('videogarage-videos')

def lambda_handler(event, context):
    # CognitoのJWTトークンからuserIdを取得
    user_id = event['requestContext']['authorizer']['jwt']['claims']['sub']


    #  URLパラメータからtabIdを取得
    tab_id = event['pathParmeters']['tabId']

    # タブを削除
    tabs_table.delete_item(
        Key={
            'userId': user_id,
            'tabId': tab_id
        }
    )

    # そのタブに紐づく動画も全部削除機能
    videos_response = videos_table.query(
        KeyConditionExpression=Key('userId').eq(user_id)
    )

    for video in videos_response['Items']:
        if video.get('tabId') == tab_id:
            videos_table.delete_item(
                Key={
                    'userId': user_id,
                    'videoId': video['videoId']
                }
            )

    return {
        'statusCode': 200,
        'headers': {
            'Access-Control-Allow-Origin': 'http://videogarage.jp',
            'Content-Type': 'application/json'
        },
        'body': json.dumps({'message': 'tab and related videos deleted'})
    }

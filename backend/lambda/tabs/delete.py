import json
import boto3
from boto3.dynamodb.conditions import Key, Attr

dynamodb = boto3.resource('dynamodb')
tabs_table = dynamodb.Table('videogarage-tabs')
videos_table = dynamodb.Table('videogarage-videos')


def lambda_handler(event, context):
    # CognitoのJWTトークンからuserIdを取得
    user_id = event['requestContext']['authorizer']['jwt']['claims']['sub']

    # URLパラメータからtabIdを取得
    tab_id = event['pathParameters']['tabId']

    # 1. このタブに紐づく動画を取得（FilterExpressionで絞り込み）
    videos_response = videos_table.query(
        KeyConditionExpression=Key('userId').eq(user_id),
        FilterExpression=Attr('tabId').eq(tab_id)
    )

    # 2. 該当する動画を全部削除（batch_writerで効率的に）
    with videos_table.batch_writer() as batch:
        for video in videos_response['Items']:
            batch.delete_item(
                Key={
                    'userId': user_id,
                    'videoId': video['videoId']
                }
            )

    # 3. 最後にタブ自体を削除
    tabs_table.delete_item(
        Key={
            'userId': user_id,
            'tabId': tab_id
        }
    )

    return {
        'statusCode': 200,
        'headers': {
            'Access-Control-Allow-Origin': 'https://videogarage.jp',
            'Content-Type': 'application/json'
        },
        'body': json.dumps({'message': 'videos and tab deleted'})
    }

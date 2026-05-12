import json
import boto3
from boto3.dynamodb.conditions import Key

dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table('videogarage-videos')


def lambda_handler(event, context):
    # CognitoのJWTトークンからuserIdを取得
    user_id = event['requestContext']['authorizer']['jwt']['claims']['sub']

    # DynamoDBからそのユーザーの動画一覧を取得
    response = table.query(
        KeyConditionExpression=Key('userId').eq(user_id)
    )
    
    # 取得した動画リストを返す
    return {
        'statusCode': 200,
        'headers': {
            'Access-Control-Allow-Origin': 'https://videogarage.jp',
            'Content-Type': 'applivation/json'
        },
        'body': json.dumps(response['Items'])
    }

#ロール
resource "aws_iam_role" "read_role" {
  name = "videogarage-read-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      },
    ]
  })
}

resource "aws_iam_role" "write_role" {
  name = "videogarage-write-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      },
    ]
  })
}

# VideoPost
# Twitch の Client Secret を読むため、tabs-post と共用の write_role から分離している
resource "aws_iam_role" "videos_post_role" {
  name = "videogarage-videos-post-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      },
    ]
  })
}

# VideoDelete
resource "aws_iam_role" "videos_delete_role" {
  name = "videogarage-video-delete-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      },
    ]
  })
}

# TabsDelete
resource "aws_iam_role" "tabs_delete_role" {
  name = "videogarage-tabs-delete-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      },
    ]
  })
}

# ポリシー
resource "aws_iam_policy" "read_policy" {
  name = "videogarage-db-read-policy"
  path = "/"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:Query",
        ]
        Resource = [
          aws_dynamodb_table.videogarage_videos.arn,
          aws_dynamodb_table.videogarage_tabs.arn,
        ]
      },
    ]
  })
}

resource "aws_iam_policy" "write_policy" {
  name = "videogarage-db-write-policy"
  path = "/"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:PutItem"
        ]
        Resource = [
          aws_dynamodb_table.videogarage_videos.arn,
          aws_dynamodb_table.videogarage_tabs.arn,
        ]
      },
    ]
  })
}

resource "aws_iam_policy" "videos_post_policy" {
  name = "videogarage-videos-post-policy"
  path = "/"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          # GetItem は取得済みサムネの引き継ぎに使う
          "dynamodb:GetItem",
          "dynamodb:PutItem"
        ]
        Resource = [
          aws_dynamodb_table.videogarage_videos.arn,
        ]
      },
      {
        # SecureString は AWS 管理キー（aws/ssm）で暗号化しているため kms:Decrypt は不要
        Effect = "Allow"
        Action = ["ssm:GetParameters"]
        Resource = [
          "arn:aws:ssm:ap-northeast-1:${data.aws_caller_identity.current.account_id}:parameter${local.twitch_client_id_param}",
          "arn:aws:ssm:ap-northeast-1:${data.aws_caller_identity.current.account_id}:parameter${local.twitch_client_secret_param}",
        ]
      },
    ]
  })
}

resource "aws_iam_policy" "delete_videos_policy" {
  name = "videogarage-db-delete-videos-policy"
  path = "/"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:DeleteItem"
        ]
        Resource = [
          aws_dynamodb_table.videogarage_videos.arn,
        ]
      },
    ]
  })
}
resource "aws_iam_policy" "delete_tabs_policy" {
  name = "videogarage-db-delete-tabs-policy"
  path = "/"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:Query",
          "dynamodb:BatchWriteItem"
        ]
        Resource = [
          aws_dynamodb_table.videogarage_videos.arn,
        ]
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:DeleteItem"]
        Resource = [aws_dynamodb_table.videogarage_tabs.arn]
      },
    ]
  })
}

# ポリシーをロールにアタッチ

resource "aws_iam_role_policy_attachment" "read_attach" {
  role       = aws_iam_role.read_role.name
  policy_arn = aws_iam_policy.read_policy.arn
}

resource "aws_iam_role_policy_attachment" "write_attach" {
  role       = aws_iam_role.write_role.name
  policy_arn = aws_iam_policy.write_policy.arn
}

resource "aws_iam_role_policy_attachment" "videos_post_attach" {
  role       = aws_iam_role.videos_post_role.name
  policy_arn = aws_iam_policy.videos_post_policy.arn
}

resource "aws_iam_role_policy_attachment" "videos_delete_attach" {
  role       = aws_iam_role.videos_delete_role.name
  policy_arn = aws_iam_policy.delete_videos_policy.arn
}

resource "aws_iam_role_policy_attachment" "tabs_delete_attach" {
  role       = aws_iam_role.tabs_delete_role.name
  policy_arn = aws_iam_policy.delete_tabs_policy.arn
}

resource "aws_iam_role_policy_attachment" "logs_attach" {
  for_each = {
    read_role          = aws_iam_role.read_role.name
    write_role         = aws_iam_role.write_role.name
    tabs_delete_role   = aws_iam_role.tabs_delete_role.name
    videos_post_role   = aws_iam_role.videos_post_role.name
    videos_delete_role = aws_iam_role.videos_delete_role.name
  }

  role       = each.value
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

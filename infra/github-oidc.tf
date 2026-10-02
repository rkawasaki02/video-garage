data "aws_caller_identity" "current" {}

locals {
  github_repo         = "rkawasaki02/video-garage"
  tfstate_bucket_name = "videogarage-tfstate"
}

# ── OIDC プロバイダ(plan/apply 共通) ──

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

# ── stateバケットへのアクセス(両ロール共通) ──

data "aws_iam_policy_document" "tfstate_access" {
  statement {
    actions   = ["s3:ListBucket"]
    resources = ["arn:aws:s3:::${local.tfstate_bucket_name}"]
  }

  # use_lockfile が .tflock を作成・削除するため
  # plan のみのロールでも Put/Delete が必要

  statement {
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
    ]
    resources = ["arn:aws:s3:::${local.tfstate_bucket_name}/videogarage/*"]
  }
}


resource "aws_iam_policy" "tfstate_access" {
  name   = "videogarage-tfstate-access"
  policy = data.aws_iam_policy_document.tfstate_access.json
}

# ── plan 用ロール(PR と main のデプロイ前 plan から引き受け) ──

data "aws_iam_policy_document" "plan_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values = [
        "repo:${local.github_repo}:pull_request",
        # deploy.yml の承認前 plan ジョブ(environment なし)用
        "repo:${local.github_repo}:ref:refs/heads/main",
      ]
    }
  }
}

resource "aws_iam_role" "github_plan" {
  name               = "videogarage-github-actions-plan"
  assume_role_policy = data.aws_iam_policy_document.plan_assume.json
}

resource "aws_iam_role_policy_attachment" "plan_readonly" {
  role       = aws_iam_role.github_plan.name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}

resource "aws_iam_role_policy_attachment" "plan_tfstate" {
  role       = aws_iam_role.github_plan.name
  policy_arn = aws_iam_policy.tfstate_access.arn
}

# ── apply 用ロール(mainブランチから引き受け) ──
data "aws_iam_policy_document" "apply_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${local.github_repo}:environment:production"]
    }
  }
}

resource "aws_iam_role" "github_apply" {
  name               = "videogarage-github-actions-apply"
  assume_role_policy = data.aws_iam_policy_document.apply_assume.json
}

resource "aws_iam_role_policy_attachment" "apply_poweruser" {
  role       = aws_iam_role.github_apply.name
  policy_arn = "arn:aws:iam::aws:policy/PowerUserAccess"
}

resource "aws_iam_role_policy_attachment" "apply_tfstate" {
  role       = aws_iam_role.github_apply.name
  policy_arn = aws_iam_policy.tfstate_access.arn
}

# PowerUserAccess は IAM 操作を含まないため個別に付与。
# videogarage-* に限定し、無関係なロールを触れないようにしている。
data "aws_iam_policy_document" "apply_iam" {
  statement {
    actions = [
      "iam:GetRole",
      "iam:CreateRole",
      "iam:DeleteRole",
      "iam:UpdateRole",
      "iam:TagRole",
      "iam:UntagRole",
      "iam:ListRoleTags",
      "iam:ListRolePolicies",
      "iam:GetRolePolicy",
      "iam:PutRolePolicy",
      "iam:DeleteRolePolicy",
      "iam:ListAttachedRolePolicies",
      "iam:AttachRolePolicy",
      "iam:DetachRolePolicy",
      "iam:PassRole",
    ]
    resources = [
      "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/videogarage-*",
    ]
  }
  statement {
    actions = [
      "iam:GetPolicy",
      "iam:GetPolicyVersion",
      "iam:CreatePolicy",
      "iam:CreatePolicyVersion",
      "iam:DeletePolicy",
      "iam:DeletePolicyVersion",
      "iam:ListPolicyVersions",
      "iam:ListEntitiesForPolicy",
      "iam:ListPolicyTags",
      "iam:TagPolicy",
      "iam:UntagPolicy",
    ]
    resources = [
      "arn:aws:iam::${data.aws_caller_identity.current.account_id}:policy/videogarage-*",
    ]
  }
  # OIDCプロバイダは plan の refresh で読むだけ
  statement {
    actions   = ["iam:GetOpenIDConnectProvider"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "apply_iam" {
  name   = "videogarage-apply-iam"
  role   = aws_iam_role.github_apply.id
  policy = data.aws_iam_policy_document.apply_iam.json
}

# ── GitHub の Variables に登録するARN ──

output "github_plan_role_arn" {
  value = aws_iam_role.github_plan.arn
}

output "github_apply_role_arn" {
  value = aws_iam_role.github_apply.arn
}

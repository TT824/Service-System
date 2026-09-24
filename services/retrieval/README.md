# 检索侧车（`services/retrieval/`）

本仓库唯一的一段 Python：一个把 `bge-reranker-base` 包成 HTTP 接口的 FastAPI 服务，
给 API 的检索读路径做交叉编码重排。

## 为什么有它

两条召回腿和它们之间的融合**都只读排名**：关键词腿数命中词数，语义腿量余弦距离，
融合按 RRF 把两个排名合起来。没有任何一步把「问题」和「切片」放进同一个表达式，
所以「有棵树内裤 黑色」的前五里会塞着灰色和蓝色——管线里没有东西能看出问题里那个
颜色词是决定性的。交叉编码器读的正是这个：它把 (问题, 切片) 当成一对送进同一个
前向，一次读两个字符串。

顺序是：**两条腿 → 融合（取 20 条候选）→ 重排（取前 5）**。融合仍然先跑，因为重排
是每个候选一次前向，只负担得起一份短名单——短名单就是融合的用处。

## 起服务

```bash
cd services/retrieval
python -m venv .venv
./.venv/Scripts/python.exe -m pip install torch --index-url https://download.pytorch.org/whl/cpu
./.venv/Scripts/python.exe -m pip install -r requirements.txt
./.venv/Scripts/python.exe fetch_model.py          # ~1.1GB，只跑一次
./.venv/Scripts/python.exe -m uvicorn app:app --host 127.0.0.1 --port 8000
```

首次拉模型有两个坑，`fetch_model.py` 里都写死了，这里说清楚是为什么：

- **走 `hf-mirror.com`**。本机 `huggingface.co` 完全不响应（实测 curl 拿不到状态码）。
- **`HF_HUB_DISABLE_XET=1`**。不禁用 Xet 传输后端的话，镜像会把配置文件都发下来，
  然后在权重上返回 `401 Unauthorized`（`cas-server.xethub.hf.co`，镜像不代理它）。
  结果是留下一个「看起来像模型」的目录——config、tokenizer 都在，只有 4.9MB——
  而 `from_pretrained` 报的是"缺权重文件"，不是"下载失败"。

模型只在启动时载入一次（本机实测 2.2s），之后不再碰网络。

## 接口

| | |
|---|---|
| `GET /health` | `{status, model, model_path, loaded, load_seconds, load_error, device, max_length, max_documents}`。`status` 只在模型真的驻留时是 `ok`——一个明明不能重排却答 `ok` 的健康检查，会让调用方的降级逻辑永远够不着 |
| `POST /rerank` | `{model?, query, documents[], top_n?}` → `{model, results: [{index, score}]}`，按分数降序 |

关于 `/rerank` 的四条约定：

1. **`results` 是排好序的，`index` 指的是请求里 `documents` 的下标。** 不是把数组重排
   一遍，是给每个位置一个分数——调用方自己排序、自己破平。返回的是**全部**文档
   （除非 `top_n` 收窄），不是筛过的列表：调用方要知道它第六名落在哪。
2. **`score` 是原始 logit，不套 sigmoid。** 变换是单调的，改不了排序；而一个没校准过
   的模型给出的"概率"是个假的分寸。排序才是契约。
3. **`model` 对不上就 409。** 调用方配了个名字，这里载入的是另一个，那返回的每一个
   分数描述的都是调用方没要的模型——和「重排器压根没帮上忙」外观完全一样。
4. **文档文本从不回显。** 切片是租户自己的内容：校验错误不回显，推理失败不回显，
   日志里也不回显。500 只带异常**类型名**，不带 message（torch/transformers 的异常
   会把输入引出来）。

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `RERANK_MODEL_PATH` | `./models/bge-reranker-base` | 权重目录 |
| `RERANK_MODEL_NAME` | `bge-reranker-base` | 对外报的名字，也是 `/rerank` 的 `model` 校验对象 |
| `RERANK_MAX_LENGTH` | `512` | 单对截断长度。**调小它是这里最有效的降本手段** |
| `RERANK_MAX_DOCUMENTS` | `64` | 一批的上限，超了 413 |

**没有并发调优。** 一次前向 `torch.inference_mode()` 加一把锁顺序执行。这个服务的
请求来自坐席看会话时的读路径，量级上不需要并发；真需要时该动的是批量而不是线程。

## 验收

```bash
./.venv/Scripts/python.exe smoke_test.py
```

它既是延迟量具，也是**判据**：拿「有棵树内裤 黑色」去问一条只有颜色不同的候选表，
黑色必须排第一；再拿蓝色问一遍。两个正确解都**不在输入的第一个位置**——最初的版本
里我问的是灰色，而灰色本来就在开头，于是一个原样返回输入的服务照样绿。这个坑值得
留着：那一版看起来像在证明排序有效，其实什么都没证明。

Node 侧的单测（`packages/core/src/http-rerank-provider.spec.ts`）跑在假端口上，不需要
这个服务、不需要模型、在任何机器上都能跑——但也因此**不能**告诉你这台机器上的服务是
不是在排序。冒烟探针不能替代它，它也不能替代冒烟探针。

## 与主仓库的关系

- 读路径通过 `RERANK_BASE_URL` / `RERANK_MODEL` 找到这个服务；任一为空即不绑定
  provider，读路径按融合顺序作答（`packages/core/src/http-rerank-provider.ts`）。
- 这个服务**不是**生产必填项。没有它只是排序差一点，答案依然完整；而没配嵌入服务
  是静默什么都不索引——所以嵌入那两个变量在 `APP_ENV=production` 必填，这两个不必填。
- 时延口径、超时为什么按「坐席愿意等多久」而不是按最坏情况定，见
  `packages/core/src/app-config.ts` 的 `DEFAULT_RERANK_TIMEOUT_MS`。

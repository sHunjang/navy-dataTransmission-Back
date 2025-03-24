const express = require("express");
const cors = require("cors");
const fs = require("fs").promises;
const path = require("path");
const multer = require("multer");           // multer 추가
const WebSocket = require("ws");
const { Worker, isMainThread } = require("worker_threads");

const app = express();
const port = 8080;

app.use(cors());
app.use(express.json());

// multer 설정: 파일들을 "uploads" 폴더에 저장
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, "uploads/"); // 업로드 폴더 (미리 생성 필요)
    },
    filename: (req, file, cb) => {
        // 파일 원본명을 그대로 사용 (원본 파일명이 displayName으로 사용됨)
        cb(null, file.originalname);
    }
});
const upload = multer({ storage });

// 업로드된 파일들을 정적 파일로 서비스 (다운로드 URL 제공)
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// 다중 파일 업로드 엔드포인트
app.post("/upload", upload.array("files", 10), (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ message: "파일 업로드 실패" });
    }
    // 각 파일에 대해 다운로드 URL과 원본 파일명을 생성
    const downloadFiles = req.files.map(file => ({
        url: `http://${req.headers.host}/uploads/${encodeURIComponent(file.filename)}`,
        displayName: file.originalname
    }));
    res.json({ message: "파일 업로드 완료", downloadFiles });
});

// WebSocket 서버 설정 (옵션)
const wss = new WebSocket.Server({ noServer: true });
wss.on("connection", (ws) => {
    console.log("WebSocket 클라이언트와 연결됨");
    ws.on("message", (message) => {
        console.log("클라이언트로부터 받은 메시지:", message);
        ws.send(`서버에서 받은 메시지: ${message}`);
    });
    ws.on("close", () => {
        console.log("WebSocket 클라이언트와 연결 종료됨");
    });
});

// "files" 폴더와 "files2" 폴더에서 파일 존재 여부를 확인하는 함수
const getFilePath = async (fileName) => {
    // 우선 "files" 폴더에서 확인
    let filePath = path.resolve(__dirname, "files", fileName);
    try {
        await fs.access(filePath);
        return filePath;
    } catch (error) {
        // "files"에 없으면 "files2" 폴더에서 확인
        filePath = path.resolve(__dirname, "files2", fileName);
        await fs.access(filePath);
        return filePath;
    }
};

// 단일 스레드 파일 처리 함수 (순차 처리)
const processFileAsync = async (fileName) => {
    try {
        const filePath = await getFilePath(fileName);
        await fs.readFile(filePath);
        return `파일 처리 완료: ${fileName}`;
    } catch (error) {
        console.error("app.js - 파일 처리 중 오류 발생:", error);
        return `파일 처리 실패: ${fileName}`;
    }
};

// 멀티 스레드 처리 함수 (worker_threads 사용)
function processFilesInWorker(fileNames, threads) {
    return new Promise((resolve, reject) => {
        const workerPath = path.resolve(__dirname, "workers", "worker.js");
        const worker = new Worker(workerPath);

        worker.on("message", (result) => {
            resolve(result);
        });

        worker.on("error", reject);

        worker.on("exit", (code) => {
            if (code !== 0) reject(new Error(`Worker stopped with exit code ${code}`));
        });

        // 전달 객체의 키 이름을 fileNames와 threads로 설정합니다.
        worker.postMessage({ fileNames, threads });
    });
}

// 단일 스레드 전송 엔드포인트 (순차 처리)
app.post("/send-single", async (req, res) => {
    const fileNames = req.body;
    console.log("단일 스레드 전송, 파일 이름들:", fileNames);
    try {
        for (let fileName of fileNames) {
            const result = await processFileAsync(fileName);
            console.log(result);
        }
        res.json({ message: "단일 스레드 전송 완료" });
    } catch (error) {
        console.error("단일 스레드 전송 중 오류 발생:", error);
        res.status(500).json({ message: "전송 실패", error: error.message });
    }
});

// 멀티 스레드 전송 엔드포인트 (병렬 처리)
app.post("/send-multiple", async (req, res) => {
    const { fileNames, threads } = req.body;
    console.log("멀티 스레드 전송, 파일 이름들:", fileNames, "스레드 수:", threads);
    try {
        const result = await processFilesInWorker(fileNames, threads);
        res.json({ message: "멀티 스레드 전송 완료", results: result });
    } catch (error) {
        console.error("멀티 스레드 전송 중 오류 발생:", error);
        res.status(500).json({ message: "전송 실패", error: error.message });
    }
});

// 실험 결과 자동 저장 엔드포인트
app.post("/save-result", async (req, res) => {
    try {
        const resultData = req.body; // 실험 결과 데이터
        const { experiment_datetime, file_count, single_thread_time, multi_thread_results } = resultData;
        const lines = [];
        lines.push("[실험 일시]");
        lines.push(experiment_datetime);
        lines.push("");
        lines.push("[실험 조건]");
        lines.push(`파일 수: ${file_count}개`);
        lines.push("");
        lines.push("[결과]");
        lines.push(`- 단일 스레드 처리 시간: ${single_thread_time}ms`);
        for (const threadCount in multi_thread_results) {
            lines.push(`- 멀티 스레드 처리 시간 (${threadCount} threads): ${multi_thread_results[threadCount]}ms`);
        }
        const content = lines.join("\n");

        // 결과 저장 폴더 (results) 생성 (없으면 자동 생성)
        const resultsDir = path.resolve(__dirname, "results");
        await fs.mkdir(resultsDir, { recursive: true });
        // 타임스탬프를 포함한 파일명 생성
        const timestamp = new Date().toISOString().replace(/[:.-]/g, "");
        const fileName = `experiment_result_${timestamp}.txt`;
        const filePath = path.join(resultsDir, fileName);
        await fs.writeFile(filePath, content, { encoding: "utf-8" });
        res.json({ message: "실험 결과 저장 완료", filePath });
    } catch (error) {
        console.error("실험 결과 저장 중 오류 발생:", error);
        res.status(500).json({ message: "실험 결과 저장 실패", error: error.message });
    }
});

// 서버 실행 및 WebSocket 업그레이드 처리
app.server = app.listen(port, "0.0.0.0", () => {
    console.log(`서버가 ${port} 포트에서 실행 중입니다.`);
});

app.server.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
    });
});

// 워커 스레드 코드는 worker.js에 따로 있음
if (!isMainThread) {
    // 이 부분은 실행되지 않습니다. 워커 스레드 코드는 workers/worker.js 파일에서 관리됩니다.
}
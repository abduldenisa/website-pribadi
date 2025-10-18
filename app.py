import os, traceback
from io import BytesIO
from PIL import Image, UnidentifiedImageError
from fastapi import FastAPI, File, UploadFile, Request
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.middleware.cors import CORSMiddleware

try:
    from ultralytics import YOLO
except Exception as e:
    YOLO = None
    print("WARNING: Ultralytics import failed:", e)

app = FastAPI(title="YOLOv8 — Clean Stable")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

MODEL_PATH = os.getenv("MODEL_PATH", "weights/best.pt")
DEFAULT_CONF = float(os.getenv("DEFAULT_CONF", "0.25"))
DEFAULT_IOU = float(os.getenv("DEFAULT_IOU", "0.45"))
DEFAULT_IMGSZ = int(os.getenv("DEFAULT_IMGSZ", "640"))

model = None
model_names = {}

def load_model():
    global model, model_names
    if YOLO is None:
        return "Ultralytics not available"
    if not os.path.exists(MODEL_PATH):
        return f"Model file not found at {MODEL_PATH}"
    try:
        model = YOLO(MODEL_PATH)
        names = getattr(model, "names", {})
        if isinstance(names, dict):
            model_names = {int(k) if not isinstance(k, int) else k: v for k, v in names.items()}
        elif isinstance(names, (list, tuple)):
            model_names = {i: n for i, n in enumerate(names)}
        else:
            model_names = {}
        return None
    except Exception as e:
        model = None
        return f"Failed to load model: {e}"

load_err = load_model()
if load_err:
    print("WARNING:", load_err)

@app.get("/healthz", response_class=PlainTextResponse)
def healthz():
    return "ok"

@app.get("/model")
def model_info():
    if model is None:
        return JSONResponse({"error": load_err or "Model not loaded."}, status_code=500)
    classes = [model_names[i] for i in sorted(model_names.keys())] if model_names else []
    return {"classes": classes, "model_path": MODEL_PATH}

@app.get("/", response_class=HTMLResponse)
def home(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})

@app.post("/predict")
async def predict(
    file: UploadFile = File(...),
    conf: float = DEFAULT_CONF,
    iou: float = DEFAULT_IOU,
    imgsz: int = DEFAULT_IMGSZ
):
    if model is None:
        return JSONResponse({"error": load_err or "Model not loaded. Ensure weights/best.pt exists or set MODEL_PATH."}, status_code=500)
    if file is None:
        return JSONResponse({"error": "No file received"}, status_code=400)
    # Be lenient with content types (canvas blobs can vary); try to decode regardless.
    try:
        image_bytes = await file.read()
        if not image_bytes:
            return JSONResponse({"error": "Empty image payload"}, status_code=400)
        try:
            image = Image.open(BytesIO(image_bytes))
            image.load()
            image = image.convert("RGB")
        except UnidentifiedImageError:
            return JSONResponse({"error": "Unrecognized or corrupt image file"}, status_code=400)

        try:
            results = model.predict(image, conf=float(conf), iou=float(iou), imgsz=int(imgsz), verbose=False)
        except Exception as e:
            return JSONResponse({"error": f"Inference error: {e}"}, status_code=500)

        r = results[0]
        boxes = []
        if getattr(r, "boxes", None) is not None:
            xyxy = r.boxes.xyxy.cpu().numpy() if hasattr(r.boxes.xyxy, "cpu") else r.boxes.xyxy
            clss = r.boxes.cls.cpu().numpy().astype(int) if hasattr(r.boxes.cls, "cpu") else r.boxes.cls
            confs = r.boxes.conf.cpu().numpy() if hasattr(r.boxes.conf, "cpu") else r.boxes.conf
            for (x1, y1, x2, y2), c, p in zip(xyxy.tolist(), clss.tolist(), confs.tolist()):
                name = model_names.get(int(c), str(int(c)))
                boxes.append({"x1": x1, "y1": y1, "x2": x2, "y2": y2, "cls": int(c), "name": name, "conf": float(p)})
        w, h = image.size
        return JSONResponse({"width": w, "height": h, "boxes": boxes})
    except Exception as e:
        print("SERVER ERROR:", e)
        traceback.print_exc()
        return JSONResponse({"error": f"Server exception: {e}"}, status_code=500)

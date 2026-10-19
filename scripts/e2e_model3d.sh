#!/bin/bash
# 3D 图片端到端测试：用测试账号走线上正常流程（参考图是 Poly Haven 的 CC0 模型渲染图，见 spike/img2threejs/RESULTS.md）
# 用法：scripts/e2e_model3d.sh four|one|text|engine（engine：能拆解的发动机，测拆解图、拆解动图和打印导出）
cd "$(dirname "$0")/.."
EMAIL=$(python3 -c "import json; print(json.load(open('.slate/test-user.json'))['email'])")
PW=$(python3 -c "import json; print(json.load(open('.slate/test-user.json'))['password'])")
I=spike/img2threejs/inputs
case "$1" in
  four) exec .venv/bin/python scripts/smoke.py --email "$EMAIL" --password "$PW" model "薄荷绿复古双铃闹钟，镀铬表圈和铃铛，罗马数字表盘" \
          --image $I/alarm_000.png --image $I/alarm_090.png --image $I/alarm_180.png --image $I/alarm_035.png ;;
  one)  exec .venv/bin/python scripts/smoke.py --email "$EMAIL" --password "$PW" model "复古手提双卡录音机" --image $I/boombox_34.png ;;
  text) exec .venv/bin/python scripts/smoke.py --email "$EMAIL" --password "$PW" model \
          "一台复古便携收音机：圆角长方体机身，奶油白色；正面左侧是一个大的圆形金属网孔喇叭；右侧上方是横向的调频刻度窗，刻度窗下面并排两个旋钮；顶部一条棕色皮革提手；机身底部一圈细镀铬边" ;;
  engine) exec .venv/bin/python scripts/smoke.py --email "$EMAIL" --password "$PW" model --explode \
          "四缸直列汽油发动机教学模型：铝合金缸体、缸盖和气门室盖，四个活塞连杆，曲轴和飞轮，进气歧管、排气歧管，正时皮带罩，油底壳。拆解顺序按维修时从外到里拆" ;;
esac

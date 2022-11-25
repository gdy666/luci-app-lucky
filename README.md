
luci-app-lucky lucky分支
在 https://github.com/sirpdboy/luci-app-lucky 的基础上修改
试图适配lucky非标准openwrt编译打包的lucky ipk包.
本分支本人自用,仅供参考.
配置文件架构和https://github.com/sirpdboy/luci-app-lucky 版本可能存在冲突,测试使用前先卸载删除干净之前文件.





## 使用方法
   
- 将luci-app-lucky添加至 LEDE/OpenWRT 源码的方法。



### 下载源码：

 ```Brach 
 
    进入lede/openwrt项目根目录下
    # 下载源码
	
    git clone  https://github.com/gdy666/luci-app-lucky.git package/lucky
	
 ``` 
### 配置菜单

 ```Brach
    make menuconfig
	# 找到 LuCI -> Applications, 选择 luci-app-lucky, 保存后退出。
 ``` 
 
### 编译

 ```Brach 
    # 编译lucky IPK包
    make package/lucky/lucky/compile V=s
    # 编译luci-app-lucky IPK包
    make package/lucky/luci-app-lucky/compile V=s
    
 ```


## 截图
![](./previews/001.png)
![](./previews/002.png)